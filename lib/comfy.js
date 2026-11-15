// Runs approved jobs on ComfyUI (your Mac through a Cloudflare Tunnel, or a cloud GPU).
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = JSON.parse(fs.readFileSync(path.resolve('workflows/config.json'), 'utf8'));
const base = () => (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
const hasWorkflow = (cfg) => !!cfg?.file && fs.existsSync(path.resolve('workflows', cfg.file));

function headers(extra = {}) {
  const h = { ...extra };
  if (process.env.CF_ACCESS_CLIENT_ID) {
    h['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
    h['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  return h;
}

const IMAGE_SIZES = {
  '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344],
  '4:3': [1152, 896], '3:4': [896, 1152], '21:9': [1536, 640]
};
export const VIDEO_SIZES = { '16:9': [832, 480], '9:16': [480, 832], '1:1': [640, 640] };
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|gif)$/i;
const AUDIO_EXT = /\.(flac|wav|mp3|ogg|opus|m4a|aac)$/i;

export const audioEnabled = () => hasWorkflow(CONFIG.audio);
export const imageToVideoEnabled = () => hasWorkflow(CONFIG.video_i2v);

// ---------- the tunnel lock ----------
// ComfyUI has no login. On anything but this machine or a private network it must sit behind
// Cloudflare Access, so: require the service token, and check that a request WITHOUT it is refused.
function isPrivate(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || h.endsWith('.local') || h.endsWith('.internal');
  } catch { return false; }
}

let lockCache = { at: 0, result: null };
export async function engineStatus({ fresh = false } = {}) {
  if (!fresh && Date.now() - lockCache.at < 60000 && lockCache.result) return lockCache.result;
  const url = base();
  const result = { url, private: isPrivate(url), token: !!(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET), locked: null, reachable: false, error: null };
  try {
    if (!result.private) {
      // Without the token, Cloudflare Access answers 401/403 or redirects to a login page. A 200 from ComfyUI means it is wide open.
      const open = await fetch(`${url}/system_stats`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const body = open.ok ? await open.text() : '';
      result.locked = !(open.ok && /"system"|"devices"/.test(body));
    }
    const r = await fetch(`${url}/system_stats`, { headers: headers(), redirect: 'manual', signal: AbortSignal.timeout(8000) });
    result.reachable = r.ok;
    if (!r.ok) result.error = r.status === 403 || r.status === 401 || (r.status >= 300 && r.status < 400) ? 'Cloudflare Access refused the service token. Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.' : `ComfyUI answered ${r.status}`;
  } catch (e) {
    result.error = `Can't reach the engine at ${url}. Is the Mac awake with ComfyUI and the tunnel running?`;
  }
  lockCache = { at: Date.now(), result };
  return result;
}

async function assertLocked() {
  const url = base();
  if (isPrivate(url)) return;
  if (!process.env.CF_ACCESS_CLIENT_ID || !process.env.CF_ACCESS_CLIENT_SECRET) {
    throw new Error(`Refusing to use ${url}: ComfyUI is on a public address without a Cloudflare Access service token. Lock the tunnel (build guide, Step 7) and set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.`);
  }
  const s = await engineStatus();
  if (s.locked === false) {
    throw new Error(`Refusing to use ${url}: it answers without the Access token, so anyone can use your Mac. Add a Cloudflare Access Service Auth policy for this hostname.`);
  }
}

function set(wf, mapping, value) {
  if (!mapping || value === undefined || value === null) return;
  const [node, field] = mapping;
  if (!wf[node]) throw new Error(`Workflow has no node ${node} (check workflows/config.json)`);
  wf[node].inputs[field] = value;
}

// ComfyUI's /upload/image stores any file in its input folder (videos too).
async function upload(buffer, name, type) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type }), name);
  form.append('overwrite', 'true');
  const r = await fetch(`${base()}/upload/image`, { method: 'POST', body: form, headers: headers() });
  if (!r.ok) throw new Error(`Upload to ComfyUI failed: ${r.status}`);
  return (await r.json()).name;
}

export async function fetchOutput(out) {
  const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder || '', type: out.type || 'output' });
  const r = await fetch(`${base()}/view?${q}`, { headers: headers() });
  if (!r.ok) throw new Error(`ComfyUI /view returned ${r.status}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'application/octet-stream' };
}

function loadWorkflow(cfg) {
  if (!hasWorkflow(cfg)) throw new Error(`Workflow file workflows/${cfg?.file} is missing. Export it from ComfyUI with "Export (API)".`);
  return JSON.parse(fs.readFileSync(path.resolve('workflows', cfg.file), 'utf8'));
}

// Queue a workflow and wait for its saved files.
async function queueAndWait(wf, clientId, expectedMs, onProgress) {
  const r = await fetch(`${base()}/prompt`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prompt: wf, client_id: clientId })
  }).catch(() => {
    throw new Error(`Can't reach the engine at ${base()}. Is ComfyUI (and your tunnel) running?`);
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) {
    const nodeErr = Object.values(body.node_errors || {})[0]?.errors?.[0];
    throw new Error(nodeErr ? `${nodeErr.message}: ${nodeErr.details}` : body.error?.message || `ComfyUI rejected the workflow (${r.status})`);
  }
  const promptId = body.prompt_id;

  const started = Date.now();
  while (Date.now() - started < 45 * 60 * 1000) {
    await new Promise((res) => setTimeout(res, 2000));
    onProgress(Math.min(0.95, (Date.now() - started) / expectedMs));
    const hr = await fetch(`${base()}/history/${promptId}`, { headers: headers() });
    const entry = (await hr.json())[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      const detail = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message;
      throw new Error(`ComfyUI reported an error${detail ? `: ${String(detail).trim().slice(0, 300)}` : ''}`);
    }
    const outputs = [];
    for (const node of Object.values(entry.outputs || {})) {
      // Video nodes report under "gifs", "videos" or (core SaveVideo) "images"; SaveAudio under "audio". Go by extension.
      for (const f of [...(node.images || []), ...(node.gifs || []), ...(node.videos || []), ...(node.audio || [])]) {
        if (f?.filename) outputs.push({ ...f, media: VIDEO_EXT.test(f.filename) ? 'video' : AUDIO_EXT.test(f.filename) ? 'audio' : 'image' });
      }
    }
    if (outputs.length) return outputs;
    if (entry.status?.completed) throw new Error('ComfyUI finished but saved no output. Check that the workflow ends in a Save node.');
  }
  throw new Error('Timed out waiting for ComfyUI');
}

// job: { kind: 'image'|'video', params }. source: { buffer, name } of a start image for image-to-video.
export async function runComfyJob(job, source, onProgress = () => {}) {
  await assertLocked();
  const useI2V = job.kind === 'video' && source && imageToVideoEnabled();
  const cfg = useI2V ? CONFIG.video_i2v : CONFIG[job.kind];
  const wf = loadWorkflow(cfg);
  const p = job.params;

  set(wf, cfg.nodes.prompt, p.prompt);
  set(wf, cfg.nodes.negative, p.negative_prompt);
  set(wf, cfg.nodes.seed, Math.floor(Math.random() * 2 ** 31));

  if (job.kind === 'image') {
    const [w, h] = IMAGE_SIZES[p.aspect_ratio] || IMAGE_SIZES['1:1'];
    set(wf, cfg.nodes.width, w);
    set(wf, cfg.nodes.height, h);
  } else {
    const [w, h] = VIDEO_SIZES[p.aspect_ratio] || VIDEO_SIZES['16:9'];
    set(wf, cfg.nodes.width, w);
    set(wf, cfg.nodes.height, h);
    // Wan wants 4n+1 frames; duration x fps + 1 gives that for 16 and 24 fps.
    set(wf, cfg.nodes.frames, Number(p.duration_seconds || 3) * (cfg.fps || 16) + 1);
    set(wf, cfg.nodes.fps, cfg.fps || 16);
    if (useI2V) set(wf, cfg.nodes.image, await upload(source.buffer, `src_${job.id}${path.extname(source.name) || '.png'}`, 'image/png'));
  }

  const outputs = await queueAndWait(wf, job.id, job.kind === 'image' ? 60000 : 900000, onProgress);
  if (job.kind === 'video') outputs.sort((a, b) => (b.media === 'video') - (a.media === 'video'));
  return { outputs, usedSource: !!useI2V };
}

// Sound pass: send a finished clip to the audio workflow (MMAudio), get back an audio file.
export async function runComfyAudio(job, clipFile, duration, onProgress = () => {}) {
  await assertLocked();
  const cfg = CONFIG.audio;
  const wf = loadWorkflow(cfg);
  const name = await upload(fs.readFileSync(clipFile), `clip_${job.id}.mp4`, 'video/mp4');
  set(wf, cfg.nodes.video, name);
  set(wf, cfg.nodes.prompt, job.params.sound);
  set(wf, cfg.nodes.seed, Math.floor(Math.random() * 2 ** 31));
  set(wf, cfg.nodes.duration, Math.round(duration * 100) / 100);
  const outputs = await queueAndWait(wf, `${job.id}_audio`, 120000, onProgress);
  const audio = outputs.find((o) => o.media === 'audio');
  if (!audio) throw new Error('The sound workflow saved no audio file. Make sure it ends in a Save Audio node.');
  return fetchOutput(audio);
}
