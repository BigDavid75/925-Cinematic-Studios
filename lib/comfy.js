// Runs approved jobs on ComfyUI (your Mac through a Cloudflare Tunnel, or a cloud GPU).
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = JSON.parse(fs.readFileSync(path.resolve('workflows/config.json'), 'utf8'));
const base = () => (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');

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

function set(wf, mapping, value) {
  if (!mapping || value === undefined || value === null) return;
  const [node, field] = mapping;
  if (!wf[node]) throw new Error(`Workflow has no node ${node} (check workflows/config.json)`);
  wf[node].inputs[field] = value;
}

async function uploadImage(buffer, name) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: 'image/png' }), name);
  form.append('overwrite', 'true');
  const r = await fetch(`${base()}/upload/image`, { method: 'POST', body: form, headers: headers() });
  if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
  return (await r.json()).name;
}

export async function fetchOutput(out) {
  const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder || '', type: out.type || 'output' });
  const r = await fetch(`${base()}/view?${q}`, { headers: headers() });
  if (!r.ok) throw new Error(`ComfyUI /view returned ${r.status}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'application/octet-stream' };
}

// job: { kind: 'image'|'video', params, quality }, sourceOutput optional for image-to-video
export async function runComfyJob(job, sourceOutput, onProgress = () => {}) {
  // Image-to-video uses its own workflow when one is configured; plain text-to-video uses "video".
  const i2v = job.kind === 'video' && sourceOutput && CONFIG.video_i2v;
  const cfg = (i2v && fs.existsSync(path.resolve('workflows', i2v.file)) && i2v) || CONFIG[job.kind];
  if (cfg !== i2v) sourceOutput = null; // no image-to-video workflow installed: fall back to text-to-video
  const wfPath = path.resolve('workflows', cfg.file);
  if (!fs.existsSync(wfPath)) throw new Error(`Workflow file workflows/${cfg.file} is missing. Export it from ComfyUI with "Export (API)".`);
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  const p = job.params;
  const seed = Math.floor(Math.random() * 2 ** 31);

  set(wf, cfg.nodes.prompt, p.prompt);
  set(wf, cfg.nodes.negative, p.negative_prompt);
  set(wf, cfg.nodes.seed, seed);

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
    if (sourceOutput && cfg.nodes.image) {
      const { buffer } = await fetchOutput(sourceOutput);
      set(wf, cfg.nodes.image, await uploadImage(buffer, `src_${job.id}.png`));
    }
  }

  const r = await fetch(`${base()}/prompt`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prompt: wf, client_id: job.id })
  }).catch(() => {
    throw new Error(`Can't reach the image engine at ${base()}. Is ComfyUI (and your tunnel) running?`);
  });
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(body.error?.message || `ComfyUI rejected the workflow (${r.status})`);
  const promptId = body.prompt_id;

  const started = Date.now();
  while (Date.now() - started < 45 * 60 * 1000) {
    await new Promise((res) => setTimeout(res, 2000));
    onProgress(Math.min(0.95, (Date.now() - started) / (job.kind === 'image' ? 60000 : 900000)));
    const hr = await fetch(`${base()}/history/${promptId}`, { headers: headers() });
    const hist = await hr.json();
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      const detail = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message;
      throw new Error(`ComfyUI reported an error while generating${detail ? `: ${String(detail).trim().slice(0, 300)}` : ''}`);
    }
    const outputs = [];
    for (const node of Object.values(entry.outputs || {})) {
      // Video nodes report under "gifs", "videos" or (core SaveVideo) "images", so go by the file extension.
      for (const f of [...(node.images || []), ...(node.gifs || []), ...(node.videos || [])]) {
        if (f?.filename) outputs.push({ ...f, media: VIDEO_EXT.test(f.filename) ? 'video' : 'image' });
      }
    }
    if (job.kind === 'video') outputs.sort((a, b) => (b.media === 'video') - (a.media === 'video'));
    if (outputs.length) return outputs;
    if (entry.status?.completed) throw new Error('ComfyUI finished but saved no output. Check that the workflow ends in a Save node.');
  }
  throw new Error('Timed out waiting for ComfyUI');
}
