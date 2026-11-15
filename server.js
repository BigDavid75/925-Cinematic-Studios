// OpenArtVision web server: serves the studio UI and wires the agent chat (www.openartvision.com).
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './lib/store.js';
import { runTurn, buildUserContent, makeTitle } from './lib/agent.js';
import fs from 'node:fs';
import { fetchOutput } from './lib/comfy.js';
import { creditsFor } from './lib/tools.js';
import { runMockTurn, mockTitle, mockMedia } from './lib/mock.js';
import { startJob, localFile, recoverJobs } from './lib/engine.js';
import * as projects from './lib/projects.js';
import { extractScriptText } from './lib/script.js';
import { FORMATS, ffmpegAvailable } from './lib/video.js';

const MOCK = process.env.MOCK === '1';
const PASSWORD = process.env.SITE_PASSWORD || '';
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
  res.json({ credits: store.getCredits(), sessions: store.listSessions(), projects: store.listProjects().map(projects.summary), mock: MOCK, ai: projects.canUseAI() });
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
  const { sessionId, text = '', attachments = [], model, approval = 'ask', quality = 'quality' } = req.body;
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
  session.display.push({ role: 'user', text, attachments: attachments.map((a) => ({ dataUrl: a.dataUrl, name: a.name })) });

  const opts = { model, approval, quality };
  const args = {
    session,
    userContent: buildUserContent(session, text, attachments),
    opts,
    emit,
    signal: controller.signal,
    onJobAuto: (job) => startJob(job)
  };

  try {
    await (MOCK ? runMockTurn(args) : runTurn(args));
    if (isNew || session.title === 'Untitled session') {
      const title = (MOCK ? mockTitle(text) : await makeTitle(text)) || 'Untitled session';
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
    const { prompt, aspect_ratio, resolution, duration_seconds } = req.body.params;
    Object.assign(job.params, Object.fromEntries(Object.entries({ prompt, aspect_ratio, resolution, duration_seconds }).filter(([, v]) => v !== undefined)));
    job.credits = creditsFor(job.kind, job.params, job.quality);
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
    .filter((j) => j.status === 'done' && j.outputs?.length)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 120)
    .map((j) => {
      const i = Math.max(0, j.outputs.findIndex((o) => o.media === j.kind));
      return { id: j.id, kind: j.outputs[i].media, title: j.params.title, prompt: j.params.prompt, url: `/api/media/${j.id}/${i}`, filename: j.outputs[i].filename, projectId: j.projectId, sessionId: j.sessionId };
    });
  res.json({ items });
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
  console.log(`OpenArtVision running on http://localhost:${port}${MOCK ? ' (MOCK mode)' : ''}`);
  if (!(await ffmpegAvailable())) console.warn('WARNING: ffmpeg not found; stitching and export will fail. Install ffmpeg or set FFMPEG_PATH.');
  if (!PASSWORD) console.warn('WARNING: SITE_PASSWORD is not set; anyone with the URL can use your API credits.');
});
