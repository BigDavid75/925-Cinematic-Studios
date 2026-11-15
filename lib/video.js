// ffmpeg helpers: stitch clips into one film, export it in a chosen format, and make mock clips.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(bin, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', buf = '';
    p.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `${bin} is not installed on the server (needed to stitch and export video)` : e.message)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `${bin} exited with ${code}`))));
  });
}

export async function ffmpegAvailable() {
  try { await run(FFMPEG, ['-version']); return true; } catch { return false; }
}

export async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out);
  const s = j.streams?.[0];
  if (!s) throw new Error('No video stream in clip');
  const [n, d] = String(s.r_frame_rate || '16/1').split('/').map(Number);
  const fps = d ? n / d : n || 16;
  let duration = Number(j.format?.duration);
  if (!duration && Number(s.nb_frames)) duration = Number(s.nb_frames) / fps;
  return { width: s.width, height: s.height, fps, duration: duration || 0 };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export const FORMATS = {
  mp4: { label: 'MP4 (H.264)', ext: 'mp4', mime: 'video/mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  webm: { label: 'WebM (VP9)', ext: 'webm', mime: 'video/webm', args: ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p'] },
  mov: { label: 'MOV (ProRes 422, for editing)', ext: 'mov', mime: 'video/quicktime', args: ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'] },
  gif: { label: 'GIF', ext: 'gif', mime: 'image/gif', args: [] }
};

/**
 * Joins clips in the order given into one file.
 * clips: [{ file }]   opts: { width, height, fps, transition: 'cut'|'crossfade', format }
 * Returns { duration, segments: [{ start, duration }] } with each clip's position in the film.
 */
export async function renderFilm(clips, outFile, opts = {}, onProgress = () => {}) {
  if (!clips.length) throw new Error('No clips to stitch');
  const fmt = FORMATS[opts.format || 'mp4'];
  if (!fmt) throw new Error(`Unknown format ${opts.format}`);
  const info = [];
  for (const c of clips) info.push(await probe(c.file));

  const W = even(opts.width || info[0].width);
  const H = even(opts.height || info[0].height);
  const fps = opts.fps || Math.round(info[0].fps) || 16;
  const minDur = Math.min(...info.map((i) => i.duration));
  const fade = opts.transition === 'crossfade' && clips.length > 1 ? Math.max(0.1, Math.min(0.5, minDur / 3)) : 0;

  const parts = clips.map((_, i) =>
    `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);

  const segments = [];
  let total = 0;
  if (clips.length === 1) {
    parts.push('[v0]null[film]');
    segments.push({ start: 0, duration: info[0].duration });
    total = info[0].duration;
  } else if (!fade) {
    parts.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[film]`);
    for (const i of info) { segments.push({ start: total, duration: i.duration }); total += i.duration; }
  } else {
    let prev = 'v0';
    total = info[0].duration;
    segments.push({ start: 0, duration: info[0].duration });
    for (let i = 1; i < clips.length; i++) {
      const offset = total - fade;
      const label = i === clips.length - 1 ? 'film' : `x${i}`;
      parts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}[${label}]`);
      segments.push({ start: offset, duration: info[i].duration });
      total = offset + info[i].duration;
      prev = label;
    }
  }

  let map = '[film]';
  if (fmt.ext === 'gif') {
    parts.push(`[film]fps=${Math.min(fps, 12)},scale='min(640,iw)':-2:flags=lanczos,split[ga][gb];[ga]palettegen=stats_mode=diff[gp];[gb][gp]paletteuse=dither=bayer:bayer_scale=4[gif]`);
    map = '[gif]';
  }

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  for (const c of clips) args.push('-i', c.file);
  args.push('-filter_complex', parts.join(';'), '-map', map, '-an', ...fmt.args, outFile);

  await run(FFMPEG, args, (line) => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m && total) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / total));
  });
  onProgress(1);
  return { duration: total, segments, width: W, height: H, fps, size: fs.statSync(outFile).size };
}

// ---------- mock clips (MOCK=1), so the timeline, stitch and export work without a GPU ----------
const FONTS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf'
];
const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return `0x${f(0)}${f(8)}${f(4)}`;
};

export async function makeMockClip(outFile, { width, height, duration, label = '', hue = 250, fps = 16 }) {
  const src = `gradients=s=${even(width)}x${even(height)}:c0=${hsl(hue, 0.55, 0.22)}:c1=${hsl((hue + 70) % 360, 0.6, 0.45)}:c2=${hsl((hue + 140) % 360, 0.5, 0.3)}:nb_colors=3:speed=0.03:d=${duration}:r=${fps}`;
  const font = FONTS.find((f) => fs.existsSync(f));
  const safe = label.replace(/[^\w .,#-]/g, '').slice(0, 40);
  const text = font && safe
    ? `,drawtext=fontfile='${font.replace(/:/g, '\\:')}':text='${safe}':fontcolor=white:fontsize=h/9:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.5:shadowx=2:shadowy=2,drawtext=fontfile='${font.replace(/:/g, '\\:')}':text='MOCK CLIP':fontcolor=white@0.6:fontsize=h/22:x=(w-text_w)/2:y=h-text_h*2.5`
    : '';
  const base = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src];
  const enc = ['-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile];
  try {
    await run(FFMPEG, [...base, '-vf', `format=yuv420p${text}`, ...enc]);
  } catch (e) {
    if (!text) throw e;
    await run(FFMPEG, [...base, ...enc]); // ffmpeg without drawtext: plain gradient
  }
}
