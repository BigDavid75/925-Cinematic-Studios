// Script-to-film projects: a script becomes ordered shots, each shot renders a clip, finished clips sit
// on a timeline in script order and are stitched into one film that can be exported.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';
import { parseScript, breakdownWithClaude, DURATIONS, MAX_SHOTS } from './script.js';
import { creditsFor, soundCreditsFor, ENGINES } from './tools.js';
import { enqueue, onJobSettled, localFile, soundAvailable } from './engine.js';
import { renderFilm, FORMATS } from './video.js';
import { VIDEO_SIZES } from './comfy.js';

const MOCK = process.env.MOCK === '1';
const PROJECTS_DIR = path.join(store.DATA_DIR, 'projects');
const dirOf = (p) => path.join(PROJECTS_DIR, p.id);
const ASPECTS = Object.keys(VIDEO_SIZES);
export const RESOLUTIONS = { source: null, '720p': 720, '1080p': 1080 };

export const canUseAI = () => !MOCK && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const newShot = (s) => ({
  id: store.id('shot'),
  heading: String(s.heading || '').slice(0, 90),
  text: String(s.text || '').slice(0, 1200),
  prompt: String(s.prompt || '').slice(0, 900),
  sound: String(s.sound || '').slice(0, 300),
  duration_seconds: DURATIONS.includes(Number(s.duration_seconds)) ? Number(s.duration_seconds) : 4,
  jobId: null,     // latest render attempt
  clipJobId: null  // last attempt that produced a clip (what the timeline plays)
});

export function createProject({ title, aspect_ratio, quality, style } = {}) {
  return store.putProject({
    id: crypto.randomUUID(),
    title: String(title || 'Untitled film').slice(0, 80),
    script: '',
    aspect_ratio: ASPECTS.includes(aspect_ratio) ? aspect_ratio : '16:9',
    quality: quality === 'fast' ? 'fast' : 'quality',
    style: String(style || '').slice(0, 300),
    transition: 'cut',
    sound: true,
    shots: [],
    preview: null,
    exports: [],
    createdAt: Date.now()
  });
}

export function updateProject(p, body = {}) {
  if (typeof body.title === 'string' && body.title.trim()) p.title = body.title.trim().slice(0, 80);
  if (typeof body.script === 'string') p.script = body.script.slice(0, 200000);
  if (typeof body.style === 'string') p.style = body.style.slice(0, 300);
  if (ASPECTS.includes(body.aspect_ratio)) p.aspect_ratio = body.aspect_ratio;
  if (['fast', 'quality'].includes(body.quality)) p.quality = body.quality;
  if (typeof body.sound === 'boolean' && body.sound !== (p.sound !== false)) {
    p.sound = body.sound;
    schedulePreview(p);
  }
  if (['cut', 'crossfade'].includes(body.transition) && body.transition !== p.transition) {
    p.transition = body.transition;
    schedulePreview(p);
  }
  return store.putProject(p);
}

// Replace the shot list from the script. Existing clips are dropped: the script order is the timeline order.
export async function breakdown(p, { script, ai } = {}) {
  if (typeof script === 'string') p.script = script.slice(0, 200000);
  if (!p.script.trim()) throw new Error('Add a script first');
  let shots, note = null;
  if (ai && canUseAI()) {
    try {
      const r = await breakdownWithClaude(p.script, { style: p.style });
      shots = r.shots;
      if (r.title && /^Untitled film$/i.test(p.title)) p.title = r.title;
    } catch (e) {
      console.error('AI breakdown failed, using the local parser', e);
      note = `AI breakdown failed (${e?.error?.error?.message || e.message}); split the script locally instead.`;
    }
  }
  shots ||= parseScript(p.script);
  if (!shots.length) throw new Error('Could not find any shots in that script');
  cancelQueued(p);
  p.shots = shots.map(newShot);
  schedulePreview(p);
  store.putProject(p);
  return note;
}

export function addShot(p, afterId) {
  if (p.shots.length >= MAX_SHOTS) throw new Error(`A film can have at most ${MAX_SHOTS} shots`);
  const shot = newShot({ heading: `Shot ${p.shots.length + 1}`, prompt: '', duration_seconds: 4 });
  const i = p.shots.findIndex((s) => s.id === afterId);
  p.shots.splice(i < 0 ? p.shots.length : i + 1, 0, shot);
  store.putProject(p);
  return shot;
}

export function updateShot(p, shot, body = {}) {
  if (typeof body.heading === 'string') shot.heading = body.heading.slice(0, 90);
  if (typeof body.prompt === 'string') shot.prompt = body.prompt.slice(0, 900);
  if (typeof body.sound === 'string') shot.sound = body.sound.slice(0, 300);
  if (DURATIONS.includes(Number(body.duration_seconds))) shot.duration_seconds = Number(body.duration_seconds);
  store.putProject(p);
}

export function removeShot(p, shot) {
  const job = store.getJob(shot.jobId);
  if (job?.status === 'queued') cancelJob(job);
  p.shots = p.shots.filter((s) => s.id !== shot.id);
  if (shot.clipJobId) schedulePreview(p);
  store.putProject(p);
}

// ---------- rendering shots ----------
const isBusy = (shot) => ['queued', 'running'].includes(store.getJob(shot.jobId)?.status);
const fullPrompt = (p, shot) => (p.style && !shot.prompt.toLowerCase().includes(p.style.toLowerCase()) ? `${shot.prompt.replace(/[.\s]+$/, '')}. Style: ${p.style}` : shot.prompt);
const wantsSound = (p) => p.sound !== false && soundAvailable();
const shotSound = (p, shot) => (wantsSound(p) ? (shot.sound || '').trim() || `Natural sound for: ${shot.prompt}`.slice(0, 240) : '');
export const shotCredits = (p, shot) => creditsFor('video', { duration_seconds: shot.duration_seconds, sound: shotSound(p, shot) }, p.quality);

export function generateShot(p, shot) {
  if (isBusy(shot)) throw new Error('That shot is already rendering');
  if (!shot.prompt.trim()) throw new Error(`"${shot.heading}" has no prompt`);
  const credits = shotCredits(p, shot);
  if (!store.spendCredits(credits)) { const e = new Error('Not enough credits'); e.status = 402; throw e; }
  const n = p.shots.indexOf(shot) + 1;
  const job = enqueue({
    id: store.id('job'),
    projectId: p.id,
    shotId: shot.id,
    kind: 'video',
    params: { title: `Shot ${n}: ${shot.heading}`.slice(0, 80), prompt: fullPrompt(p, shot), aspect_ratio: p.aspect_ratio, duration_seconds: shot.duration_seconds, sound: shotSound(p, shot) },
    quality: p.quality,
    engine: ENGINES.video[p.quality],
    credits,
    soundCredits: soundCreditsFor({ duration_seconds: shot.duration_seconds, sound: shotSound(p, shot) }),
    progress: 0,
    outputs: [],
    createdAt: Date.now()
  });
  shot.jobId = job.id;
  store.putProject(p);
  return job;
}

// Queue every shot that has no clip yet, in script order.
export function generateAll(p) {
  const todo = p.shots.filter((s) => !s.clipJobId && !isBusy(s) && s.prompt.trim());
  const total = todo.reduce((a, s) => a + shotCredits(p, s), 0);
  if (!todo.length) throw new Error('Every shot already has a clip');
  if (store.getCredits() < total) { const e = new Error(`Not enough credits (needs ${total})`); e.status = 402; throw e; }
  for (const s of todo) generateShot(p, s);
  return todo.length;
}

function cancelJob(job) {
  job.status = 'cancelled';
  store.spendCredits(-job.credits);
  store.putJob(job);
}
export function cancelQueued(p) {
  let n = 0;
  for (const s of p.shots) {
    const job = store.getJob(s.jobId);
    if (job?.status === 'queued') { cancelJob(job); n++; }
  }
  return n;
}

onJobSettled((job) => {
  if (!job.projectId || job.status !== 'done') return;
  const p = store.getProject(job.projectId);
  const shot = p?.shots.find((s) => s.id === job.shotId);
  if (!shot || shot.jobId !== job.id) return; // shot was deleted or re-rendered meanwhile
  const out = job.outputs.find((o) => o.media === 'video');
  if (!out || !localFile(out)) {
    job.status = 'failed';
    job.error = 'The workflow returned no video file. Make sure it ends in a video save node (MP4).';
    store.spendCredits(-job.credits);
    store.putJob(job);
    return;
  }
  shot.clipJobId = job.id;
  store.putProject(p);
  schedulePreview(p);
});

// ---------- timeline + stitching ----------
// The timeline is the shot list in script order; a shot contributes a clip once it has one.
function timelineClips(p) {
  return p.shots.map((shot) => {
    const out = store.getJob(shot.clipJobId)?.outputs?.find((o) => o.media === 'video');
    const file = localFile(out);
    return file && fs.existsSync(file) ? { shotId: shot.id, file } : null;
  }).filter(Boolean);
}

function frameSize(p, resolution = 'source') {
  const [w, h] = VIDEO_SIZES[p.aspect_ratio] || VIDEO_SIZES['16:9'];
  const short = RESOLUTIONS[resolution];
  if (!short) return { width: w, height: h };
  const k = short / Math.min(w, h);
  return { width: Math.round((w * k) / 2) * 2, height: Math.round((h * k) / 2) * 2 };
}

const building = new Map(); // project id -> { timer, running, dirty }
export function schedulePreview(p) {
  const st = building.get(p.id) || {};
  building.set(p.id, st);
  // Mark it pending now, so the page keeps polling until the new stitch is ready.
  if (p.preview || timelineClips(p).length) { p.preview = { ...(p.preview || {}), status: 'building' }; store.putProject(p); }
  clearTimeout(st.timer);
  st.timer = setTimeout(() => buildPreview(p.id), 400);
}

async function buildPreview(pid) {
  const st = building.get(pid);
  if (st.running) { st.dirty = true; return; }
  const p = store.getProject(pid);
  if (!p) return;
  const clips = timelineClips(p);
  const old = p.preview?.file;
  if (!clips.length) {
    p.preview = null;
    store.putProject(p);
    if (old) fs.rmSync(path.join(dirOf(p), old), { force: true });
    return;
  }
  st.running = true;
  const rev = Date.now().toString(36);
  const file = `preview_${rev}.mp4`;
  p.preview = { ...(p.preview || {}), status: 'building' };
  store.putProject(p);
  try {
    fs.mkdirSync(dirOf(p), { recursive: true });
    const r = await renderFilm(clips, path.join(dirOf(p), file), { ...frameSize(p), transition: p.transition, format: 'mp4', audio: p.sound !== false });
    p.preview = {
      status: 'ready', rev, file, duration: r.duration, transition: p.transition, audio: r.audio,
      segments: r.segments.map((s, i) => ({ shotId: clips[i].shotId, start: s.start, duration: s.duration }))
    };
    if (old && old !== file) fs.rmSync(path.join(dirOf(p), old), { force: true });
  } catch (e) {
    console.error('Stitch failed', e);
    p.preview = { ...(p.preview || {}), status: 'failed', error: e.message };
  }
  store.putProject(p);
  st.running = false;
  if (st.dirty) { st.dirty = false; buildPreview(pid); }
}

export const previewPath = (p) => (p.preview?.file ? path.join(dirOf(p), path.basename(p.preview.file)) : null);

// ---------- export ----------
export function startExport(p, { format = 'mp4', resolution = 'source' } = {}) {
  if (!FORMATS[format]) throw new Error('Unknown format');
  if (!(resolution in RESOLUTIONS)) throw new Error('Unknown resolution');
  const clips = timelineClips(p);
  if (!clips.length) throw new Error('Render at least one shot before exporting');
  const ex = {
    id: store.id('exp'), format, resolution, transition: p.transition, status: 'running', progress: 0,
    clips: clips.length, shots: p.shots.length, file: null, createdAt: Date.now()
  };
  p.exports.unshift(ex);
  for (const stale of p.exports.splice(8)) if (stale.file) fs.rmSync(path.join(dirOf(p), stale.file), { force: true });
  store.putProject(p);

  const file = `export_${ex.id}.${FORMATS[format].ext}`;
  fs.mkdirSync(dirOf(p), { recursive: true });
  renderFilm(clips, path.join(dirOf(p), file), { ...frameSize(p, resolution), transition: p.transition, format, audio: p.sound !== false }, (v) => { ex.progress = v; })
    .then((r) => Object.assign(ex, { status: 'done', progress: 1, file, size: r.size, duration: r.duration, width: r.width, height: r.height, audio: r.audio }))
    .catch((e) => { console.error('Export failed', e); Object.assign(ex, { status: 'failed', error: e.message }); })
    .finally(() => store.getProject(p.id) && store.putProject(p));
  return ex;
}

export function exportPath(p, ex) {
  return ex?.file ? path.join(dirOf(p), path.basename(ex.file)) : null;
}

export function deleteProject(p) {
  cancelQueued(p);
  clearTimeout(building.get(p.id)?.timer);
  store.deleteProject(p.id);
  fs.rmSync(dirOf(p), { recursive: true, force: true });
}

// After a restart: nothing is encoding any more, and previews may be stale.
export function recoverProjects() {
  for (const p of store.listProjects()) {
    for (const ex of p.exports || []) if (ex.status === 'running') Object.assign(ex, { status: 'failed', error: 'The server restarted during this export' });
    const stale = p.preview && (p.preview.status === 'building' || !fs.existsSync(previewPath(p) || ''));
    if (stale) schedulePreview(p);
  }
}

// What the browser gets: the project plus the state of each shot's jobs.
export function view(p) {
  const jobView = (id) => {
    const j = store.getJob(id);
    return j && { id: j.id, status: j.status, phase: j.phase, progress: j.progress, error: j.error, engine: j.engine, sound: j.sound, soundError: j.soundError };
  };
  const shots = p.shots.map((s) => ({
    ...s,
    job: jobView(s.jobId),
    clip: s.clipJobId ? `/api/media/${s.clipJobId}/${Math.max(0, store.getJob(s.clipJobId)?.outputs?.findIndex((o) => o.media === 'video') ?? 0)}` : null,
    credits: shotCredits(p, s)
  }));
  return {
    id: p.id, title: p.title, script: p.script, aspect_ratio: p.aspect_ratio, quality: p.quality, style: p.style,
    transition: p.transition, sound: p.sound !== false, soundAvailable: soundAvailable(), engine: ENGINES.video[p.quality], shots,
    preview: p.preview && { ...p.preview, url: p.preview.file ? `/api/projects/${p.id}/preview?v=${p.preview.rev}` : null },
    exports: p.exports.map((e) => ({ ...e, label: FORMATS[e.format]?.label, url: e.status === 'done' ? `/api/projects/${p.id}/exports/${e.id}/download` : null })),
    credits: store.getCredits(), ai: canUseAI(), updatedAt: p.updatedAt
  };
}

export const summary = (p) => ({
  id: p.id, title: p.title, updatedAt: p.updatedAt, shots: p.shots.length,
  clips: p.shots.filter((s) => s.clipJobId).length,
  poster: p.shots.find((s) => s.clipJobId) ? view(p).shots.find((s) => s.clip).clip : null
});
