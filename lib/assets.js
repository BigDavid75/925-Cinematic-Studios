// Asset library: stores uploaded images, documents and audio, makes web-friendly copies,
// extracts document text, and serves everything back to the chat, the agent and the library page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as store from './store.js';

export const ASSET_DIR = path.join(store.DATA_DIR, 'assets');
fs.mkdirSync(ASSET_DIR, { recursive: true });
const file = (name) => (name ? path.join(ASSET_DIR, path.basename(name)) : null);

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const TYPES = {
  image: ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'webp', 'gif', 'bmp', 'dib', 'tif', 'tiff', 'svg', 'avif', 'heic', 'heif', 'ico', 'tga', 'psd', 'jxl', 'jp2', 'ppm', 'pgm', 'pbm', 'pcx', 'exr', 'hdr', 'dng', 'raw', 'cr2', 'nef', 'arw'],
  document: ['pdf', 'doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf', 'txt', 'text', 'md', 'markdown', 'fountain', 'fdx', 'html', 'htm', 'csv', 'tsv', 'json', 'xml', 'srt', 'vtt'],
  audio: ['mp3', 'wav', 'wave', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'aifc', 'wma', 'amr', 'caf', 'weba', 'mka', 'mid', 'midi', 'ac3', 'alac', 'm4b']
};
export const ACCEPT = Object.values(TYPES).flat().map((e) => `.${e}`).join(',') + ',image/*,audio/*';

export function kindOf(name, mime = '') {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const [kind, exts] of Object.entries(TYPES)) if (exts.includes(ext)) return kind;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || mime.startsWith('text/') || /word|opendocument\.text|rtf/.test(mime)) return 'document';
  return null;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${bin} exited with ${code}`))));
  });
}
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// ---------- images ----------
// Any image -> a PNG/JPEG the browser and Claude can read, plus a small thumbnail.
async function decodeImage(buffer, ext) {
  const sharp = (await import('sharp')).default;
  if (ext === 'heic' || ext === 'heif') {
    try { await sharp(buffer).metadata(); } catch {
      const convert = (await import('heic-convert')).default; // iPhone photos (HEVC) are not in sharp's prebuilt libvips
      buffer = Buffer.from(await convert({ buffer, format: 'PNG' }));
    }
  }
  try {
    const img = sharp(buffer, { animated: false, limitInputPixels: 268402689 });
    await img.metadata();
    return img;
  } catch {
    // BMP, TGA, PSD, ICO, PCX, EXR... -> let ffmpeg turn the first frame into a PNG.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-'));
    try {
      const src = path.join(tmp, `in.${ext || 'img'}`);
      fs.writeFileSync(src, buffer);
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', path.join(tmp, 'out.png')]);
      return sharp(fs.readFileSync(path.join(tmp, 'out.png')));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}

async function processImage(a, buffer) {
  const img = await decodeImage(buffer, a.ext);
  const meta = await img.metadata();
  const rotated = img.rotate(); // honor EXIF orientation from phones
  const alpha = !!meta.hasAlpha;
  a.display = `${a.id}.${alpha ? 'png' : 'jpg'}`;
  const big = rotated.clone().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true });
  await (alpha ? big.png({ compressionLevel: 8 }) : big.flatten({ background: '#ffffff' }).jpeg({ quality: 90 })).toFile(file(a.display));
  a.thumb = `${a.id}.thumb.webp`;
  await rotated.clone().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(file(a.thumb));
  const out = await (await import('sharp')).default(file(a.display)).metadata();
  a.width = out.width;
  a.height = out.height;
}

// ---------- documents ----------
const stripTags = (s) => s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|Paragraph)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

function rtfToText(rtf) {
  // Drop header groups (fonts, colours, styles, document info), which can nest one level.
  rtf = rtf.replace(/\{\\(\*\\)?(fonttbl|colortbl|stylesheet|info|listtable|listoverridetable|generator)(?:[^{}]|\{[^{}]*\})*\}/g, '');
  return rtf
    .replace(/\\par[d]?/g, '\n').replace(/\\line/g, '\n').replace(/\\tab/g, '\t')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\{\\\*[^{}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').replace(/\n{3,}/g, '\n\n');
}

export async function extractText(name, buffer) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === 'pdf') {
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const r = await pdfParse(buffer);
    return { text: r.text, pages: r.numpages };
  }
  if (['docx', 'docm', 'dotx'].includes(ext)) {
    const mammoth = (await import('mammoth')).default;
    return { text: (await mammoth.extractRawText({ buffer })).value };
  }
  if (ext === 'doc' || ext === 'dot') {
    const WordExtractor = (await import('word-extractor')).default;
    const doc = await new WordExtractor().extract(buffer);
    return { text: doc.getBody() };
  }
  if (ext === 'odt') {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('content.xml')?.async('string');
    if (!xml) throw new Error('This .odt file has no text content');
    return { text: stripTags(xml.replace(/<text:(p|h)[^>]*>/g, '\n')) };
  }
  const raw = buffer.toString('utf8');
  if (/\u0000/.test(raw.slice(0, 4000))) throw new Error('This file is not a readable text document');
  if (ext === 'rtf') return { text: rtfToText(raw) };
  if (ext === 'fdx') return { text: stripTags(raw.replace(/<Paragraph[^>]*Type="([^"]+)"[^>]*>/g, '\n')) }; // Final Draft
  if (ext === 'html' || ext === 'htm' || ext === 'xml') return { text: stripTags(raw) };
  if (ext === 'srt' || ext === 'vtt') return { text: raw.split(/\r?\n/).filter((l) => !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^WEBVTT/.test(l)).join('\n') };
  return { text: raw };
}

async function processDocument(a, buffer) {
  const { text, pages } = await extractText(a.name, buffer);
  const clean = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  a.textFile = `${a.id}.txt`;
  fs.writeFileSync(file(a.textFile), clean.slice(0, 400000));
  a.chars = clean.length;
  a.words = clean ? clean.split(/\s+/).length : 0;
  a.pages = pages || null;
  a.excerpt = clean.slice(0, 600);
}

// ---------- audio ----------
const WEB_AUDIO = ['mp3', 'wav', 'wave', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'];
async function processAudio(a) {
  try {
    const out = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,sample_rate,channels', '-of', 'json', file(a.original)]);
    const j = JSON.parse(out);
    a.duration = Number(j.format?.duration) || null;
    const s = j.streams?.find((x) => x.codec_type === 'audio');
    if (s) { a.sampleRate = Number(s.sample_rate) || null; a.channels = s.channels || null; }
  } catch { /* MIDI and a few others can't be probed; still stored */ }
  // AIFF, WMA, AMR, CAF... don't play in browsers: keep the original, add an M4A to listen to.
  if (!WEB_AUDIO.includes(a.ext) && !['mid', 'midi'].includes(a.ext)) {
    a.display = `${a.id}.m4a`;
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file(a.original), '-vn', '-c:a', 'aac', '-b:a', '192k', file(a.display)]);
  } else a.display = a.original;
}

// ---------- ingest ----------
export async function ingest(buffer, { name, mime = '', sessionId = null, origin = 'upload' }) {
  name = path.basename(String(name || 'file')).replace(/[\u0000-\u001f]/g, '').slice(0, 160) || 'file';
  const kind = kindOf(name, mime);
  if (!kind) throw new Error(`${name}: this file type isn't supported. Upload images, documents (PDF, Word, text) or audio.`);
  if (!buffer?.length) throw new Error(`${name} is empty`);
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`${name} is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const ext = path.extname(name).slice(1).toLowerCase() || (kind === 'image' ? 'png' : kind === 'audio' ? 'mp3' : 'txt');
  const id = store.id('ast');
  const a = { id, kind, name, ext, mime, size: buffer.length, original: `${id}.orig.${ext}`, characterIds: [], sessionId, origin, status: 'ready', createdAt: Date.now() };
  fs.writeFileSync(file(a.original), buffer);
  try {
    if (kind === 'image') await processImage(a, buffer);
    else if (kind === 'document') await processDocument(a, buffer);
    else await processAudio(a, buffer);
  } catch (e) {
    for (const f of [a.original, a.display, a.thumb, a.textFile]) if (f) fs.rmSync(file(f), { force: true });
    throw new Error(`${name}: ${e.message}`);
  }
  return store.putAsset(a);
}

export function removeAsset(a) {
  for (const f of new Set([a.original, a.display, a.thumb, a.textFile])) if (f) fs.rmSync(file(f), { force: true });
  store.deleteAsset(a.id);
}

export const assetText = (a) => (a?.textFile && fs.existsSync(file(a.textFile)) ? fs.readFileSync(file(a.textFile), 'utf8') : '');

export function assetPath(a, variant = 'display') {
  const name = variant === 'thumb' ? a.thumb || a.display : variant === 'original' ? a.original : variant === 'text' ? a.textFile : a.display || a.original;
  const p = file(name);
  return p && fs.existsSync(p) ? p : null;
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', m4a: 'audio/mp4', txt: 'text/plain; charset=utf-8' };
export const mimeFor = (p) => MIME[path.extname(p).slice(1).toLowerCase()];

// What the browser gets.
export function view(a) {
  const url = (v) => `/api/assets/${a.id}/file${v ? `?v=${v}` : ''}`;
  return {
    id: a.id, kind: a.kind, name: a.name, ext: a.ext, size: a.size, createdAt: a.createdAt, origin: a.origin,
    width: a.width, height: a.height, duration: a.duration, pages: a.pages, words: a.words, excerpt: a.excerpt,
    characterIds: a.characterIds || [],
    url: url(), thumb: a.kind === 'image' ? url('thumb') : null, original: url('original'), text: a.textFile ? url('text') : null
  };
}

// For the agent: image blocks for pictures, the PDF itself or the extracted text for documents, a note for audio.
export function contentBlocks(a) {
  const label = `asset_id ${a.id}, ${a.kind} "${a.name}"`;
  if (a.kind === 'image') {
    const p = assetPath(a, 'display');
    if (!p) return [{ type: 'text', text: `[Image ${label} could not be read]` }];
    return [{ type: 'text', text: `[Image ${label}]` }, { type: 'image', source: { type: 'base64', media_type: p.endsWith('.png') ? 'image/png' : 'image/jpeg', data: fs.readFileSync(p).toString('base64') } }];
  }
  if (a.kind === 'document') {
    // Small PDFs go as the PDF itself (Claude sees layout and pictures); big ones as text, to keep the chat history light.
    if (a.ext === 'pdf' && a.size < 5 * 1024 * 1024 && (a.pages || 0) <= 100) {
      return [{ type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(file(a.original)).toString('base64') } }, { type: 'text', text: `[The PDF above is ${label}]` }];
    }
    const text = assetText(a);
    const cut = text.length > 80000;
    return [{ type: 'text', text: `<document ${label}${a.pages ? `, ${a.pages} pages` : ''}>\n${cut ? text.slice(0, 80000) : text}\n</document>${cut ? `\n[Only the first 80,000 of ${text.length} characters are included.]` : ''}` }];
  }
  return [{ type: 'text', text: `[Audio ${label}${a.duration ? `, ${a.duration.toFixed(1)} seconds` : ''}. You can't hear audio; use the file name and the user's words to tell what it is (a voice sample, music, a sound effect).]` }];
}
