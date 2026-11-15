// Runs generation jobs (ComfyUI, or the mock engine) and keeps a local copy of every result,
// so finished clips can be stitched and exported even when the Mac is offline.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { runComfyJob, fetchOutput, VIDEO_SIZES } from './comfy.js';
import { runMockJob } from './mock.js';
import { makeMockClip } from './video.js';

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

export async function startJob(job) {
  job.status = 'running';
  job.progress = 0.02;
  store.putJob(job);
  const session = job.sessionId && store.getSession(job.sessionId);
  try {
    const source = job.params.source_job_id ? store.getJob(job.params.source_job_id)?.outputs?.[0] : null;
    const onProgress = (p) => { job.progress = p; };
    if (MOCK) job.outputs = job.kind === 'video' ? await mockVideo(job, onProgress) : await runMockJob(job, onProgress);
    else {
      job.outputs = await runComfyJob(job, source, onProgress);
      await cacheOutputs(job);
    }
    job.status = 'done';
    job.progress = 1;
    session?.notes.push(`Job ${job.id} (${job.kind}, "${job.params.title}") finished and is shown to the user.`);
  } catch (err) {
    console.error('Job failed', err);
    job.status = 'failed';
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
