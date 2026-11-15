// Runs generation jobs (ComfyUI, or the mock engine) and keeps a local copy of every result,
// so finished clips can be stitched and exported even when the Mac is offline.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { runComfyJob, runComfyAudio, fetchOutput, audioEnabled, VIDEO_SIZES } from './comfy.js';
import { runMockJob } from './mock.js';
import { makeMockClip, makeMockAudio, muxAudio, probe } from './video.js';

const MOCK = process.env.MOCK === '1';
export const MEDIA_DIR = path.join(store.DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const localFile = (out) => (out?.local ? path.join(MEDIA_DIR, path.basename(out.local)) : null);

const settledHooks = [];
export const onJobSettled = (fn) => settledHooks.push(fn);

async function cacheOutputs(job) {
  for (const [i, out] of job.outputs.entries()) {
    if (out.local || out.mock) continue;
    const ext = (path.extname(out.filename) || (out.media === 'video' ? '.mp4' : '.png')).toLowerCase();
    const name = `${job.id}_${i}${ext}`;
    const { buffer } = await fetchOutput(out);
    fs.writeFileSync(path.join(MEDIA_DIR, name), buffer);
    out.local = name;
  }
}

async function mockVideo(job, onProgress) {
  const [width, height] = VIDEO_SIZES[job.params.aspect_ratio] || VIDEO_SIZES['16:9'];
  for (let i = 1; i <= 4; i++) { await new Promise((r) => setTimeout(r, 350)); onProgress(i / 6); }
  const name = `${job.id}_0.mp4`;
  const hue = [...job.id].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 360;
  await makeMockClip(path.join(MEDIA_DIR, name), { width, height, duration: Number(job.params.duration_seconds || 4), label: job.params.title, hue });
  return [{ filename: name, media: 'video', local: name }];
}

export const soundAvailable = () => MOCK || audioEnabled();

// Images the user attaches in chat are kept like finished jobs, so the agent can animate them by id.
export function registerUpload(session, attachment) {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(attachment?.dataUrl || '');
  if (!m) return null;
  const id = store.id('upl');
  const name = `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(m[2], 'base64'));
  return store.putJob({
    id, kind: 'upload', sessionId: session.id, status: 'done', credits: 0, progress: 1,
    params: { title: attachment.name || 'Uploaded image', prompt: '' },
    outputs: [{ filename: attachment.name || name, media: 'image', local: name }],
    createdAt: Date.now()
  });
}

// The start image for image-to-video: an earlier image result or an uploaded picture.
async function sourceImage(job) {
  const id = job.params.source_job_id;
  if (!id) return null;
  const src = store.getJob(id);
  if (!src) throw new Error(`The source image ${id} was not found`);
  const out = src.outputs?.find((o) => o.media === 'image');
  if (!out) throw new Error(`${id} has no image to animate`);
  const file = localFile(out);
  if (file && fs.existsSync(file)) return { buffer: fs.readFileSync(file), name: path.basename(file) };
  if (out.mock) return { mock: true, name: out.filename };
  const { buffer } = await fetchOutput(out);
  return { buffer, name: out.filename };
}

// Sound pass. A clip that already has sound (a video model with audio, e.g. LTX-2) keeps it.
async function addSound(job) {
  const out = job.outputs.find((o) => o.media === 'video');
  const file = localFile(out);
  if (!file) return;
  const info = await probe(file);
  if (info.audio) { job.sound = 'native'; return; }
  job.phase = 'sound';
  job.progress = 0.02;
  store.putJob(job);
  const onProgress = (p) => { job.progress = p; };
  let audioFile;
  if (MOCK) {
    audioFile = path.join(MEDIA_DIR, `${job.id}_sound.flac`);
    await new Promise((r) => setTimeout(r, 600));
    await makeMockAudio(audioFile, { duration: info.duration, seed: [...job.id].reduce((a, c) => a + c.charCodeAt(0), 0) });
  } else {
    const { buffer, type } = await runComfyAudio(job, file, info.duration, onProgress);
    audioFile = path.join(MEDIA_DIR, `${job.id}_sound.${/wav/.test(type) ? 'wav' : /mpeg/.test(type) ? 'mp3' : 'flac'}`);
    fs.writeFileSync(audioFile, buffer);
  }
  const name = `${job.id}_av.mp4`;
  await muxAudio(file, audioFile, path.join(MEDIA_DIR, name));
  fs.rmSync(audioFile, { force: true });
  if (path.basename(file) !== name) fs.rmSync(file, { force: true });
  out.local = name;
  out.filename = name;
  job.sound = 'generated';
}

export async function startJob(job) {
  job.status = 'running';
  job.phase = 'video';
  job.progress = 0.02;
  store.putJob(job);
  const session = job.sessionId && store.getSession(job.sessionId);
  try {
    const source = await sourceImage(job);
    const onProgress = (p) => { job.progress = p; };
    if (MOCK) {
      job.outputs = job.kind === 'video' ? await mockVideo(job, onProgress) : await runMockJob(job, onProgress);
      job.usedSource = !!source;
    } else {
      const r = await runComfyJob(job, source, onProgress);
      job.outputs = r.outputs;
      job.usedSource = r.usedSource;
      await cacheOutputs(job);
    }
    if (job.kind === 'video' && job.params.sound && soundAvailable()) {
      try {
        await addSound(job);
      } catch (err) {
        // The clip is fine; only the sound failed. Keep the silent clip and refund the sound part.
        console.error('Sound pass failed', err);
        job.soundError = err.message;
        store.spendCredits(-(job.soundCredits || 0));
        job.credits -= job.soundCredits || 0;
      }
    }
    job.status = 'done';
    job.phase = null;
    job.progress = 1;
    const extra = job.soundError ? ` Its sound could not be generated (${job.soundError}), so it is silent.` : job.sound ? ' It has sound.' : '';
    session?.notes.push(`Job ${job.id} (${job.kind}, "${job.params.title}") finished and is shown to the user.${extra}`);
  } catch (err) {
    console.error('Job failed', err);
    job.status = 'failed';
    job.phase = null;
    job.error = err.message;
    store.spendCredits(-job.credits); // refund
    session?.notes.push(`Job ${job.id} ("${job.params.title}") failed: ${err.message}`);
  }
  store.putJob(job);
  for (const fn of settledHooks) {
    try { await fn(job); } catch (e) { console.error('Job hook failed', e); }
  }
}

// Timeline shots render one at a time, in script order, so a 16GB Mac is never asked for two clips at once.
let chain = Promise.resolve();
export function enqueue(job) {
  job.status = 'queued';
  store.putJob(job);
  chain = chain.then(() => (store.getJob(job.id)?.status === 'queued' ? startJob(job) : null)).catch((e) => console.error(e));
  return job;
}

// After a restart nothing is actually rendering any more: fail and refund whatever was in flight.
export function recoverJobs() {
  for (const job of store.listJobs()) {
    if (job.status !== 'running' && job.status !== 'queued') continue;
    job.status = 'failed';
    job.error = 'The server restarted while this was rendering';
    store.spendCredits(-job.credits);
    store.putJob(job);
  }
}
