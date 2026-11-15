// 925 Cinematic Studios web server: serves the studio UI and wires the agent chat (www.925cinema.com).
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './lib/store.js';
import { runTurn, buildUserContent, makeTitle } from './lib/agent.js';
import fs from 'node:fs';
import { fetchOutput, engineStatus, imageToVideoEnabled } from './lib/comfy.js';
import { creditsFor, soundCreditsFor } from './lib/tools.js';
import { runMockTurn, mockTitle, mockMedia } from './lib/mock.js';
import { startJob, localFile, recoverJobs, soundAvailable } from './lib/engine.js';
import * as assets from './lib/assets.js';
import * as characters from './lib/characters.js';
import * as projects from './lib/projects.js';
import { extractScriptText } from './lib/script.js';
import { FORMATS, ffmpegAvailable } from './lib/video.js';

const MOCK = process.env.MOCK === '1';
const PASSWORD = process.env.SITE_PASSWORD || '';
const PRODUCTION = process.env.NODE_ENV === 'production';

// Without a password, anyone who finds the site can spend your Claude API credits and use your Mac.
if (PRODUCTION && !MOCK && (!PASSWORD || PASSWORD === 'change-me')) {
  console.error('Refusing to start: set SITE_PASSWORD (not "change-me") before putting the site online.');
  process.exit(1);
}
if (PRODUCTION && !process.env.COOKIE_SECRET) console.warn('WARNING: COOKIE_SECRET is not set; everyone is logged out on every restart.');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '40mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex')));
app.use(express.static(path.resolve('public')));

app.get('/healthz', (req, res) => res.json({ ok: true })); // for the host's health check

// ---------- auth (single password gate; add real accounts later) ----------
app.post('/api/login', (req, res) => {
  const ok = PASSWORD && crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(req.body.password || '')).digest(),
    crypto.createHash('sha256').update(PASSWORD).digest()
  );
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  res.cookie('oav', 'ok', { signed: true, httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 864e5 });
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  if (!PASSWORD || req.signedCookies.oav === 'ok') return next();
  res.status(401).json({ error: 'login_required' });
});

// ---------- state ----------
app.get('/api/state', (req, res) => {
  res.json({ credits: store.getCredits(), sessions: store.listSessions(), projects: store.listProjects().map(projects.summary), mock: MOCK, ai: projects.canUseAI(), sound: soundAvailable(), imageToVideo: MOCK || imageToVideoEnabled(), accept: assets.ACCEPT, library: { assets: store.listAssets().length, characters: store.listCharacters().length } });
});

// Is the Mac reachable, and is the tunnel locked? Shown as the engine pill in the top bar.
app.get('/api/engine', async (req, res) => {
  if (MOCK) return res.json({ mock: true, reachable: true, locked: true, private: true });
  const s = await engineStatus({ fresh: req.query.fresh === '1' });
  res.json({ ...s, url: undefined });
});

app.get('/api/sessions/:id', (req, res) => {
  const s = store.getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  const jobs = {};
  for (const e of s.display) for (const p of e.parts || []) if (p.type === 'job') jobs[p.jobId] = store.getJob(p.jobId);
  res.json({ id: s.id, title: s.title, display: s.display, jobs });
});

app.delete('/api/sessions/:id', (req, res) => {
  store.deleteSession(req.params.id);
  res.json({ ok: true });
});

// ---------- chat (Server-Sent Events over a POST) ----------
app.post('/api/chat', async (req, res) => {
  const { sessionId, text = '', assetIds = [], attachments = [], model, approval = 'ask', quality = 'quality' } = req.body;
  let session = sessionId && store.getSession(sessionId);
  const isNew = !session;
  if (!session) session = store.createSession();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  emit('session', { id: session.id, title: session.title });

  // Files arrive already uploaded to the asset library (assetIds). Older clients may still send data URLs.
  const sent = assetIds.slice(0, 20).map((id) => store.getAsset(id)).filter(Boolean);
  for (const a of attachments.slice(0, 4)) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(a.dataUrl || '');
    if (m) try { sent.push(await assets.ingest(Buffer.from(m[2], 'base64'), { name: a.name || 'image.png', mime: m[1], sessionId: session.id })); } catch (e) { emit('error', { message: e.message }); }
  }
  for (const a of sent) if (!a.sessionId) { a.sessionId = session.id; store.putAsset(a); }
  session.display.push({ role: 'user', text, assets: sent.map((a) => ({ id: a.id, kind: a.kind, name: a.name })) });

  // File the uploads under the right characters before the agent sees them.
  let assignment = null;
  if (sent.length) {
    emit('library_pending', { count: sent.length });
    assignment = await characters.autoAssign(sent, text);
    const part = { type: 'library', lines: [
      ...(assignment.created.length ? [`New characters: ${assignment.created.map((c) => c.name).join(', ')}`] : []),
      ...assignment.summary.map((x) => `${x.name} → ${x.characters.length ? x.characters.join(', ') : 'unassigned'}`)
    ] };
    session.pendingLibrary = part;
    emit('library', part);
  }

  const opts = { model, approval, quality };
  const args = {
    session,
    userContent: buildUserContent(session, text, sent, assignment),
    assignment,
    opts,
    emit,
    signal: controller.signal,
    onJobAuto: (job) => startJob(job)
  };

  try {
    await (MOCK ? runMockTurn(args) : runTurn(args));
    // Show the library card at the top of this reply when the session is reopened.
    if (session.pendingLibrary) {
      const last = session.display.at(-1);
      if (last?.role === 'assistant') last.parts.unshift(session.pendingLibrary);
      delete session.pendingLibrary;
    }
    if (isNew || session.title === 'Untitled session') {
      const titleFrom = text || `Files: ${sent.map((a) => a.name).join(', ')}`;
      const title = (MOCK ? mockTitle(titleFrom) : await makeTitle(titleFrom)) || 'Untitled session';
      session.title = title;
      store.save();
      emit('title', { title });
    }
    emit('done', { credits: store.getCredits() });
  } catch (err) {
    if (controller.signal.aborted) {
      // User pressed stop: drop the unfinished user turn so the transcript stays valid.
      const last = session.messages.at(-1);
      if (last?.role === 'user') session.messages.pop();
      store.save();
    } else {
      console.error(err);
      emit('error', { message: err?.error?.error?.message || err.message || 'Something went wrong' });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ---------- jobs (approval cards) ----------
app.get('/api/jobs/:id', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found' });
  res.json({ ...job, credits_left: store.getCredits() });
});

app.post('/api/jobs/:id/approve', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found' });
  if (job.status !== 'awaiting_approval') return res.status(409).json({ error: `Job is ${job.status}` });
  if (req.body?.params) {
    const { prompt, aspect_ratio, resolution, duration_seconds, sound } = req.body.params;
    Object.assign(job.params, Object.fromEntries(Object.entries({ prompt, aspect_ratio, resolution, duration_seconds }).filter(([, v]) => v !== undefined)));
    if (job.kind === 'video' && typeof sound === 'string') job.params.sound = soundAvailable() ? sound.trim().slice(0, 300) : '';
    job.credits = creditsFor(job.kind, job.params, job.quality);
    job.soundCredits = job.kind === 'video' ? soundCreditsFor(job.params) : 0;
  }
  if (!store.spendCredits(job.credits)) return res.status(402).json({ error: 'Not enough credits' });
  store.getSession(job.sessionId)?.notes.push(`User approved job ${job.id} ("${job.params.title}")${req.body?.params ? ' after editing it' : ''}.`);
  startJob(job);
  res.json({ ...job, credits_left: store.getCredits() });
});

app.post('/api/jobs/:id/dismiss', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found' });
  if (job.status === 'awaiting_approval') {
    job.status = 'dismissed';
    store.putJob(job);
    store.getSession(job.sessionId)?.notes.push(`User dismissed job ${job.id} ("${job.params.title}").`);
  }
  res.json(job);
});

app.get('/api/media/:jobId/:index', async (req, res) => {
  const job = store.getJob(req.params.jobId);
  const out = job?.outputs?.[Number(req.params.index)];
  if (!out) return res.status(404).end();
  try {
    // Finished results are kept on the server's disk; sendFile handles Range requests so video can seek.
    const file = localFile(out);
    if (file && fs.existsSync(file)) return res.set('Cache-Control', 'private, max-age=31536000, immutable').sendFile(file);
    if (out.mock) return res.type('image/svg+xml').send(mockMedia(job));
    const { buffer, type } = await fetchOutput(out);
    res.set('Cache-Control', 'private, max-age=31536000, immutable').type(type).send(buffer);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/gallery', (req, res) => {
  const items = store.listJobs()
    .filter((j) => j.status === 'done' && j.outputs?.length && j.kind !== 'upload')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 120)
    .map((j) => {
      const i = Math.max(0, j.outputs.findIndex((o) => o.media === j.kind));
      return { id: j.id, kind: j.outputs[i].media, title: j.params.title, prompt: j.params.prompt, url: `/api/media/${j.id}/${i}`, filename: j.outputs[i].filename, projectId: j.projectId, sessionId: j.sessionId };
    });
  res.json({ items });
});

// ---------- asset library ----------
// Uploads are sent as the raw file body (any size up to 200 MB), name and type in the query string.
app.post('/api/assets', express.raw({ type: () => true, limit: assets.MAX_UPLOAD_BYTES }), async (req, res) => {
  try {
    const a = await assets.ingest(req.body, { name: String(req.query.name || 'file'), mime: String(req.query.type || req.headers['content-type'] || ''), sessionId: req.query.sessionId || null });
    let assignment = null;
    if (req.query.assign === '1') assignment = await characters.autoAssign([a], String(req.query.context || ''));
    res.json({ asset: assets.view(store.getAsset(a.id)), assignment });
  } catch (e) {
    res.status(e.type === 'entity.too.large' ? 413 : 400).json({ error: e.type === 'entity.too.large' ? 'That file is over 200 MB' : e.message });
  }
});

app.get('/api/assets', (req, res) => {
  let list = store.listAssets();
  if (req.query.kind) list = list.filter((a) => a.kind === req.query.kind);
  if (req.query.character === 'none') list = list.filter((a) => !a.characterIds?.length);
  else if (req.query.character) list = list.filter((a) => a.characterIds?.includes(req.query.character));
  if (req.query.q) { const q = String(req.query.q).toLowerCase(); list = list.filter((a) => a.name.toLowerCase().includes(q)); }
  res.json({ assets: list.map(assets.view), characters: store.listCharacters().map(characters.characterView), accept: assets.ACCEPT, ai: characters.canUseAI() });
});

app.get('/api/assets/:id', (req, res) => {
  const a = store.getAsset(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  res.json(assets.view(a));
});

app.get('/api/assets/:id/file', (req, res) => {
  const a = store.getAsset(req.params.id);
  const variant = ['thumb', 'original', 'text'].includes(req.query.v) ? req.query.v : 'display';
  const p = a && assets.assetPath(a, variant);
  if (!p) return res.status(404).end();
  const type = assets.mimeFor(p);
  if (type) res.type(type);
  if (variant === 'original' || req.query.download === '1') res.attachment(a.name);
  res.set('Cache-Control', 'private, max-age=31536000, immutable').sendFile(p);
});

app.patch('/api/assets/:id', (req, res) => {
  const a = store.getAsset(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) a.name = req.body.name.trim().slice(0, 160);
  if (Array.isArray(req.body.characterIds)) characters.assign(a, req.body.characterIds, { replace: true });
  if (Array.isArray(req.body.add)) characters.assign(a, req.body.add);
  if (Array.isArray(req.body.remove)) characters.unassign(a, req.body.remove);
  store.putAsset(a);
  res.json(assets.view(a));
});

app.delete('/api/assets/:id', (req, res) => {
  const a = store.getAsset(req.params.id);
  if (a) assets.removeAsset(a);
  res.json({ ok: true });
});

// Re-run the matcher on some or all unassigned assets.
app.post('/api/assets/assign', async (req, res) => {
  const ids = Array.isArray(req.body.assetIds) && req.body.assetIds.length ? req.body.assetIds : store.listAssets().filter((a) => !a.characterIds?.length).map((a) => a.id);
  const list = ids.slice(0, 40).map((id) => store.getAsset(id)).filter(Boolean);
  const r = await characters.autoAssign(list, String(req.body.context || ''));
  res.json(r);
});

// Save a generated image or clip into the library (e.g. a character sheet the agent made).
app.post('/api/assets/from-job/:jobId/:index', async (req, res) => {
  const job = store.getJob(req.params.jobId);
  const out = job?.outputs?.[Number(req.params.index)];
  if (!out) return res.status(404).json({ error: 'not_found' });
  try {
    const p = localFile(out);
    let buffer;
    if (p && fs.existsSync(p)) buffer = fs.readFileSync(p);
    else if (out.mock) buffer = Buffer.from(mockMedia(job));
    else buffer = (await fetchOutput(out)).buffer;
    if (out.media === 'video') return res.status(400).json({ error: 'Clips stay in the Gallery; the asset library holds images, documents and audio.' });
    const name = `${(job.params.title || 'generated').replace(/[^\w\- ]+/g, '').trim() || 'generated'}${out.mock ? '.svg' : path.extname(out.filename) || '.png'}`;
    const a = await assets.ingest(buffer, { name, sessionId: job.sessionId, origin: 'generated' });
    const assignment = await characters.autoAssign([a], `${job.params.title}. ${job.params.prompt}`);
    res.json({ asset: assets.view(store.getAsset(a.id)), assignment });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/characters', (req, res) => res.json({ characters: store.listCharacters().map(characters.characterView) }));
app.post('/api/characters', (req, res) => {
  try { res.json(characters.characterView(characters.createCharacter(req.body))); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/characters/:id', (req, res) => {
  const c = store.getCharacter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) {
    const other = characters.findCharacter(req.body.name);
    if (other && other.id !== c.id) return res.status(409).json({ error: `There is already a character named ${other.name}` });
    c.name = req.body.name.trim().slice(0, 60);
  }
  if (typeof req.body.description === 'string') c.description = req.body.description.slice(0, 600);
  store.putCharacter(c);
  res.json(characters.characterView(c));
});
app.delete('/api/characters/:id', (req, res) => {
  store.deleteCharacter(req.params.id);
  res.json({ ok: true });
});

// ---------- studio: script -> shots -> timeline -> film ----------
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};
const withProject = (fn) => wrap(async (req, res) => {
  const p = store.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const shot = req.params.shotId ? p.shots.find((s) => s.id === req.params.shotId) : undefined;
  if (req.params.shotId && !shot) return res.status(404).json({ error: 'not_found' });
  const extra = await fn(p, req, res, shot);
  if (extra !== false) res.json({ ...projects.view(p), ...(extra || {}) }); // false = the handler replied itself
});

// Uploaded script file (.txt .md .fountain .docx .pdf .srt) -> plain text
app.post('/api/script/extract', wrap(async (req, res) => {
  const { name = 'script.txt', dataUrl = '' } = req.body;
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const text = await extractScriptText(String(name), Buffer.from(b64, 'base64'));
  if (!text) throw new Error('No text found in that file');
  res.json({ text: text.slice(0, 200000) });
}));

app.post('/api/projects', wrap(async (req, res) => {
  const p = projects.createProject(req.body);
  projects.updateProject(p, { script: req.body.script });
  res.json(projects.view(p));
}));
app.get('/api/projects/:id', withProject(() => {}));
app.patch('/api/projects/:id', withProject((p, req) => { projects.updateProject(p, req.body); }));
app.delete('/api/projects/:id', withProject((p, req, res) => { projects.deleteProject(p); res.json({ ok: true }); return false; }));

app.post('/api/projects/:id/breakdown', withProject(async (p, req) => ({ note: await projects.breakdown(p, req.body) })));
app.post('/api/projects/:id/shots', withProject((p, req) => { projects.addShot(p, req.body?.after); }));
app.patch('/api/projects/:id/shots/:shotId', withProject((p, req, res, shot) => { projects.updateShot(p, shot, req.body); }));
app.delete('/api/projects/:id/shots/:shotId', withProject((p, req, res, shot) => { projects.removeShot(p, shot); }));
app.post('/api/projects/:id/shots/:shotId/generate', withProject((p, req, res, shot) => {
  projects.updateShot(p, shot, req.body);
  projects.generateShot(p, shot);
}));
app.post('/api/projects/:id/generate', withProject((p) => ({ queued: projects.generateAll(p) })));
app.post('/api/projects/:id/cancel', withProject((p) => ({ cancelled: projects.cancelQueued(p) })));

app.get('/api/projects/:id/preview', withProject((p, req, res) => {
  const file = projects.previewPath(p);
  if (!file || !fs.existsSync(file)) res.status(404).end();
  else res.set('Cache-Control', 'private, max-age=31536000, immutable').sendFile(file);
  return false;
}));

app.post('/api/projects/:id/exports', withProject((p, req) => { projects.startExport(p, req.body); }));
app.get('/api/projects/:id/exports/:exportId/download', withProject((p, req, res) => {
  const ex = p.exports.find((e) => e.id === req.params.exportId);
  const file = projects.exportPath(p, ex);
  if (!file || ex.status !== 'done' || !fs.existsSync(file)) { res.status(404).end(); return false; }
  const name = (p.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'film').slice(0, 60);
  res.download(file, `${name}.${FORMATS[ex.format].ext}`);
  return false;
}));

app.get('*', (req, res) => res.sendFile(path.resolve('public/index.html')));

recoverJobs();
projects.recoverProjects();

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  console.log(`925 Cinematic Studios running on http://localhost:${port}${MOCK ? ' (MOCK mode)' : ''}`);
  if (!(await ffmpegAvailable())) console.warn('WARNING: ffmpeg not found; stitching and export will fail. Install ffmpeg or set FFMPEG_PATH.');
  if (!MOCK) {
    const e = await engineStatus({ fresh: true });
    if (!e.private && !e.token) console.warn(`WARNING: COMFY_URL (${e.url}) is public but CF_ACCESS_CLIENT_ID/SECRET are not set. Generation is blocked until the tunnel is locked.`);
    else if (e.locked === false) console.warn(`WARNING: ${e.url} answers without the Cloudflare Access token. Generation is blocked until you add an Access policy.`);
    else console.log(e.reachable ? `Engine reachable at ${e.url}${e.private ? '' : ' (locked with Cloudflare Access)'}` : `Engine not reachable yet: ${e.error}`);
  }
  if (!PASSWORD) console.warn('WARNING: SITE_PASSWORD is not set; anyone with the URL can use your API credits.');
});
