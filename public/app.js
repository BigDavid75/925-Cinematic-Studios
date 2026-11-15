// 925 Cinematic Studios studio front end: home composer -> agent session with streamed thinking, approval cards and replies.
import * as studio from './studio.js';
import * as library from './library.js';
import { uploadFile, assetTile, messageAsset } from './files.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MODELS = [
  { key: 'sonnet-5.5', label: 'Sonnet 5.5', note: 'Fast and smart (default)' },
  { key: 'opus-5.5', label: 'Opus 5.5', note: 'Deepest creative reasoning' },
  { key: 'haiku-5.5', label: 'Haiku 5.5', note: 'Quickest replies' }
];

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('oav:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('oav:' + k, JSON.stringify(v)); } catch {} }
};

const state = {
  sessionId: null,
  running: null, // AbortController
  attachments: [],
  model: store.get('model', 'sonnet-5.5'),
  approval: store.get('approval', 'ask'),
  quality: store.get('quality', 'quality'),
  jobs: {},
  sound: false,
  polling: new Set()
};

// ---------- composer setup ----------
const composer = $('#composerTpl').content.firstElementChild.cloneNode(true);
$('#homeSlot').append(composer);
const input = $('#input', composer);
const sendBtn = $('#send', composer);

function updateLabels() {
  $('#modelLabel', composer).textContent = MODELS.find((m) => m.key === state.model)?.label || 'Sonnet 5.5';
  $('#modeLabel', composer).innerHTML = `${state.approval === 'ask' ? 'Ask' : 'Auto'} <i>•</i> <em>${state.quality === 'quality' ? 'Quality' : 'Fast'}</em>`;
}
function updateSend() {
  sendBtn.disabled = !state.running && !input.value.trim() && !state.attachments.some((a) => a.status !== 'error');
  composer.classList.toggle('running', !!state.running);
  sendBtn.setAttribute('aria-label', state.running ? 'Stop' : 'Send');
}
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}
input.addEventListener('input', () => { autosize(); updateSend(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); }
});
composer.addEventListener('submit', (e) => { e.preventDefault(); state.running ? stop() : send(); });
composer.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'attach') $('#fileInput').click();
  if (act === 'reference') $('#refInput').click();
  if (act === 'plus') openMenu(e.target.closest('button'), plusMenu(), 'below-left');
  if (act === 'sketch') openSketch();
  if (act === 'reset') { input.value = ''; state.attachments = []; renderAttachments(); autosize(); updateSend(); }
  if (act === 'model') openMenu(e.target.closest('button'), modelMenu());
  if (act === 'mode') openMenu(e.target.closest('button'), modeMenu());
});

// Pages other than the agent chat: 'studioList', 'studio' (one film), 'gallery'. null = chat/home.
function showPage(name) {
  for (const id of ['studioList', 'studio', 'gallery', 'assets']) $('#' + id).hidden = id !== name;
  if (name) { $('#home').hidden = true; $('#thread').hidden = true; $('#bottomSlot').hidden = true; }
  if (name !== 'studio') studio.close();
  setNav(name === 'gallery' ? 'gallery' : name === 'assets' ? 'assets' : name ? 'studio' : 'home');
  $('#sidebar').classList.remove('open');
}
const setNav = (nav) => document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));

function placeComposer(inSession) {
  showPage(null);
  composer.classList.toggle('in-session', inSession);
  input.placeholder = inSession ? 'Send a message...' : 'Describe what you want to create...';
  (inSession ? $('#bottomSlot') : $('#homeSlot')).append(composer);
  $('#home').hidden = inSession;
  $('#thread').hidden = !inSession;
  $('#bottomSlot').hidden = !inSession;
  setNav(inSession ? 'agent' : 'home');
}

// ---------- attachments: images, documents and audio, uploaded to the asset library as soon as they're picked ----------
const MAX_FILES = 20;
let attKey = 0;
function addFiles(files) {
  const list = [...files].filter((f) => f && f.size !== undefined);
  const room = MAX_FILES - state.attachments.length;
  if (list.length > room) toast(`Up to ${MAX_FILES} files per message`);
  for (const file of list.slice(0, Math.max(0, room))) {
    const isImage = /^image\//.test(file.type) && !/heic|heif|tiff|x-tga|vnd\.adobe/.test(file.type);
    const att = { key: ++attKey, name: file.name, kind: guessKind(file), preview: isImage ? URL.createObjectURL(file) : null, progress: 0, status: 'uploading' };
    state.attachments.push(att);
    att.promise = uploadFile(file, { sessionId: state.sessionId }, (p) => { att.progress = p; paintAttachment(att); })
      .then(({ asset }) => { Object.assign(att, asset, { status: 'ready', preview: att.preview }); att.assetId = asset.id; })
      .catch((err) => { att.status = 'error'; att.error = err.message; toast(err.message); if (err.login) showLogin(); })
      .finally(() => { renderAttachments(); updateSend(); });
  }
  renderAttachments(); updateSend();
}
function guessKind(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (file.type.startsWith('image/') || ['heic', 'heif', 'avif', 'tif', 'tiff', 'bmp', 'svg', 'tga', 'psd', 'jxl'].includes(ext)) return 'image';
  if (file.type.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'wma', 'amr', 'caf'].includes(ext)) return 'audio';
  return 'document';
}
function attachAssets(assets) {
  for (const a of assets) {
    if (state.attachments.some((x) => x.assetId === a.id) || state.attachments.length >= MAX_FILES) continue;
    state.attachments.push({ key: ++attKey, ...a, assetId: a.id, status: 'ready', promise: Promise.resolve() });
  }
  renderAttachments(); updateSend(); input.focus();
}
library.onUseInChat((assets) => { if (!state.sessionId && $('#home').hidden) goHome(); attachAssets(assets); });
for (const id of ['#fileInput', '#refInput']) {
  $(id).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
}
function paintAttachment(att) {
  const el = $(`#attachments [data-key="${att.key}"]`, composer);
  if (el) el.outerHTML = tileFor(att, state.attachments.indexOf(att));
}
const tileFor = (a, i) => assetTile(a, { removable: true, index: i, pending: a.status === 'uploading' ? a : null }).replace('class="tile', `data-key="${a.key}" class="tile`);
function renderAttachments() {
  const el = $('#attachments', composer);
  el.innerHTML = state.attachments.map(tileFor).join('');
}
$('#attachments', composer).addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (!rm) return;
  const [gone] = state.attachments.splice(+rm.dataset.rm, 1);
  if (gone?.preview) URL.revokeObjectURL(gone.preview);
  renderAttachments(); updateSend();
});

// Drag and drop anywhere on the chat, and paste from the clipboard.
let dragDepth = 0;
const chatVisible = () => !$('#home').hidden || !$('#thread').hidden;
addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types?.includes('Files') || !(chatVisible() || !$('#assets').hidden)) return; dragDepth++; $('#dropVeil').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropVeil').hidden = true; } });
addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0; $('#dropVeil').hidden = true;
  if (!$('#assets').hidden) return library.uploadFiles(e.dataTransfer.files);
  if (chatVisible()) addFiles(e.dataTransfer.files);
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// ---------- popover menus ----------
const pop = $('#popover');
function openMenu(anchor, html, align = 'right') {
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = align === 'right' ? r.right - w : r.left;
  pop.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + 'px';
  pop.style.top = (align === 'below-left' || align === 'below' ? (r.bottom + 8 + h < innerHeight ? r.bottom + 8 : r.top - h - 8) : (r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8)) + 'px';
}
document.addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-act="model"],[data-act="mode"],[data-act="plus"],#newMenu,#recentsFilter,[data-more]')) pop.hidden = true; });
function plusMenu() {
  return `<button class="pop-item" data-pop="upload"><span>Upload files<small>Images, documents (PDF, Word, text) and audio</small></span></button>
    <button class="pop-item" data-pop="library"><span>From asset library<small>Attach images, documents or audio you uploaded before</small></span></button>`;
}
const check = (on) => (on ? '<span class="check">✓</span>' : '');
function modelMenu() {
  return `<div class="pop-label">Agent model</div>` + MODELS.map((m) => `<button class="pop-item" data-model="${m.key}"><span>${m.label}<small>${m.note}</small></span>${check(m.key === state.model)}</button>`).join('');
}
function modeMenu() {
  return `<div class="pop-label">Approvals</div>
    <button class="pop-item" data-approval="ask"><span>Ask<small>Show a card; nothing runs until you approve</small></span>${check(state.approval === 'ask')}</button>
    <button class="pop-item" data-approval="auto"><span>Auto<small>Run generations right away</small></span>${check(state.approval === 'auto')}</button>
    <div class="pop-label">Generation</div>
    <button class="pop-item" data-quality="quality"><span>Quality<small>FLUX / Wan 2.2 5B, slower</small></span>${check(state.quality === 'quality')}</button>
    <button class="pop-item" data-quality="fast"><span>Fast<small>SDXL / Wan 1.3B, half the credits</small></span>${check(state.quality === 'fast')}</button>`;
}
pop.addEventListener('click', (e) => {
  const b = e.target.closest('.pop-item');
  if (!b) return;
  const act = b.dataset.pop;
  if (act) {
    pop.hidden = true;
    if (act === 'upload') $('#fileInput').click();
    if (act === 'library') library.openPicker(attachAssets);
    if (act === 'new-chat') goHome();
    if (act === 'new-film') studio.newFilm().then(openFilm).catch((err) => toast(err.message));
    if (act === 'new-upload') openAssets().then(() => library.chooseFiles());
    if (act.startsWith('filter-')) { store.set('recentsFilter', act.slice(7)); refreshState(); }
    if (act === 'fill') { input.value = b.dataset.fill; input.focus(); autosize(); updateSend(); }
    return;
  }
  if (b.dataset.model) store.set('model', (state.model = b.dataset.model));
  if (b.dataset.approval) store.set('approval', (state.approval = b.dataset.approval));
  if (b.dataset.quality) store.set('quality', (state.quality = b.dataset.quality));
  pop.hidden = true;
  updateLabels();
});

// ---------- markdown (small, safe) ----------
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function md(text) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (/^\s*[-*•]$/.test(line)) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push('<li></li>'); }
    else if ((m = /^\s*[-*•]\s+(.*)/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^#{1,4}\s+(.*)/.exec(line))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if (!line.trim()) { close(); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

// ---------- rendering ----------
const msgs = $('#messages');
const thread = $('#thread');
let stick = true;
thread.addEventListener('scroll', () => { stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; });
const scroll = (force) => { if (force || stick) thread.scrollTop = thread.scrollHeight; };

// User message: the text plus its files (asset-library items; older sessions stored image URLs).
function renderUser(text, assets = [], legacy = []) {
  const el = document.createElement('div');
  el.className = 'msg-user';
  const files = [...assets.map(messageAsset), ...legacy.map((a) => `<span class="m-asset m-image"><img src="${esc(a.dataUrl)}" alt=""></span>`)];
  el.innerHTML = (files.length ? `<div class="u-atts">${files.join('')}</div>` : '') + esc(text);
  msgs.append(el);
}
msgs.addEventListener('click', (e) => {
  const a = e.target.closest('[data-asset]');
  if (a) library.openAsset(a.dataset.asset);
});

// "Filed in the asset library" card shown before the agent's reply.
function libraryCard(part) {
  const el = document.createElement('div');
  el.className = 'lib-note';
  el.innerHTML = `<div class="lib-note-head"><span>◫</span> Asset library</div>${part.lines.map((l) => `<div>${esc(l)}</div>`).join('')}<button type="button" class="lib-note-open" data-go-assets>Open library ›</button>`;
  el.querySelector('[data-go-assets]').onclick = () => openAssets();
  return el;
}

function newAssistant() {
  const el = document.createElement('div');
  el.className = 'msg-assistant';
  msgs.append(el);
  return el;
}
function pendingEl() {
  const p = document.createElement('div');
  p.className = 'pending';
  p.innerHTML = '<span class="spinner"></span><span>Thinking...</span>';
  return p;
}

function thinkingEl(text = '', done = false, seconds = 0) {
  const el = document.createElement('div');
  el.className = 'thinking ' + (done ? 'done' : 'live');
  el.innerHTML = `<button class="think-head" type="button"><span class="spinner"></span><span class="think-label">${done ? `Thought for ${seconds}s` : 'Thinking'}</span><span class="think-chev">›</span></button><div class="think-body"><div class="think-text"></div></div>`;
  $('.think-text', el).textContent = text;
  $('.think-head', el).onclick = () => { if (el.classList.contains('done')) el.classList.toggle('open'); };
  return el;
}
function finishThinking(el, seconds) {
  el.classList.remove('live');
  el.classList.add('done');
  $('.think-label', el).textContent = `Thought for ${seconds}s`;
  if (!$('.think-text', el).textContent.trim()) el.remove();
}

function draftingCard() {
  const el = document.createElement('div');
  el.className = 'card drafting';
  el.innerHTML = `<div class="card-head"><b>Writing prompt...</b><button class="icon-btn" type="button" disabled>✕</button></div>
    <div class="skel" style="width:70%"></div>
    <div class="skel-grid">${'<div class="skel" style="width:40%"></div><div class="skel" style="width:30%;justify-self:end"></div>'.repeat(3)}</div>
    <div class="card-actions"><button class="btn" disabled>Edit</button><button class="btn" disabled>Approve</button></div>`;
  return el;
}

const RATIOS = { image: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'], video: ['16:9', '9:16', '1:1'] };

function jobCard(job) {
  const el = document.createElement('div');
  el.className = 'card job';
  el.dataset.job = job.id;
  updateJobCard(el, job);
  return el;
}

function updateJobCard(el, job) {
  state.jobs[job.id] = job;
  const p = job.params;
  const kindTitle = job.kind === 'video' ? 'Generate Video' : 'Generate Image';
  const rows = [
    ['Aspect ratio', p.aspect_ratio],
    job.kind === 'video' ? ['Duration', `${p.duration_seconds}s`] : ['Resolution', p.resolution],
    ...(job.kind === 'video' && state.sound ? [['Sound', p.sound || 'Silent']] : []),
    ['Model', job.engine],
    ['Credits', job.credits]
  ];
  // Image-to-video: show the picture the clip starts from.
  const sourceHtml = job.kind === 'video' && p.source_job_id
    ? `<div class="card-source"><img src="${p.source_job_id.startsWith('ast_') ? `/api/assets/${esc(p.source_job_id)}/file?v=thumb` : `/api/media/${esc(p.source_job_id)}/0`}" alt=""><span>Starts from this image${job.status === 'done' && job.usedSource === false ? ' (no image-to-video workflow installed, so it was made from the prompt)' : ''}</span></div>`
    : '';
  const editing = el.classList.contains('editing');
  el.classList.toggle('dismissed', job.status === 'dismissed');

  let body = '';
  if (editing) {
    body = `<textarea data-f="prompt">${esc(p.prompt)}</textarea>
      <dl class="card-rows"><dt>Aspect ratio</dt><dd><select data-f="aspect_ratio">${RATIOS[job.kind].map((r) => `<option ${r === p.aspect_ratio ? 'selected' : ''}>${r}</option>`).join('')}</select></dd>
      ${job.kind === 'video'
        ? `<dt>Duration</dt><dd><select data-f="duration_seconds">${[2, 3, 4, 5].map((d) => `<option value="${d}" ${d == p.duration_seconds ? 'selected' : ''}>${d}s</option>`).join('')}</select></dd>`
        : `<dt>Resolution</dt><dd><select data-f="resolution">${['1K', '2K'].map((r) => `<option ${r === p.resolution ? 'selected' : ''}>${r}</option>`).join('')}</select></dd>`}
      ${job.kind === 'video' && state.sound ? `<dt>Sound</dt><dd><input data-f="sound" value="${esc(p.sound || '')}" maxlength="300" placeholder="Silent"></dd>` : ''}
      </dl>
      <div class="card-actions"><button class="btn" data-a="cancel-edit">Cancel</button><button class="btn btn-primary" data-a="approve">Approve</button></div>`;
  } else {
    body = `${sourceHtml}<button class="card-prompt" type="button" data-a="toggle-prompt"><span>${esc(p.prompt)}</span><span class="chev-r">›</span></button>
      <dl class="card-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    if (job.status === 'awaiting_approval') body += `<div class="card-actions"><button class="btn btn-primary" data-a="approve">Approve</button></div>`;
    if (job.status === 'running') body += `<div class="progress"><div style="width:${Math.round(job.progress * 100)}%"></div></div><div class="card-status">${job.phase === 'sound' ? 'Adding sound' : `Generating on ${esc(job.engine)}`}... ${Math.round(job.progress * 100)}%</div>`;
    if (job.status === 'done' && job.soundError) body += `<div class="card-status err">Sound failed (${esc(job.soundError)}), so this clip is silent. Sound credits refunded.</div>`;
    if (job.status === 'failed') body += `<div class="card-status err">Failed: ${esc(job.error)}. Credits refunded.</div>`;
    if (job.status === 'dismissed') body += `<div class="card-status">Dismissed</div>`;
    if (job.status === 'done') {
      body += job.outputs.map((o, i) => {
        const src = `/api/media/${job.id}/${i}`;
        if (o.media === 'audio') return '';
        return `<div class="card-media">${o.media === 'video' && !/\.(gif|webp)$/i.test(o.filename) ? `<video src="${src}" controls loop playsinline></video>` : `<img src="${src}" alt="${esc(p.title)}">`}</div>
          <div class="media-actions"><a href="${src}" download="${esc(o.filename)}">Download</a><a href="${src}" target="_blank" rel="noopener">Open</a>${o.media === 'image' ? `<button type="button" class="link" data-a="save-asset" data-index="${i}">Save to asset library</button>` : ''}</div>`;
      }).join('');
    }
  }
  const canEdit = job.status === 'awaiting_approval' && !editing;
  el.innerHTML = `<div class="card-head"><b>${kindTitle}</b>${canEdit ? '<button class="icon-btn" data-a="edit" title="Edit">✎</button><button class="icon-btn" data-a="dismiss" title="Dismiss">✕</button>' : ''}</div>${body}`;
  if (job.status === 'running') poll(job.id);
}

msgs.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  const card = e.target.closest('.card.job');
  if (!a || !card) return;
  const job = state.jobs[card.dataset.job];
  if (a === 'toggle-prompt') card.classList.toggle('prompt-open');
  if (a === 'save-asset') {
    const btn = e.target.closest('[data-a]');
    btn.disabled = true;
    try {
      const r = await api(`/api/assets/from-job/${job.id}/${btn.dataset.index}`, { method: 'POST' });
      const who = r.assignment?.summary?.[0]?.characters || [];
      btn.textContent = who.length ? `Saved · ${who.join(', ')}` : 'Saved to library';
    } catch (err) { toast(err.message); btn.disabled = false; }
  }
  if (a === 'edit') { card.classList.add('editing'); updateJobCard(card, job); }
  if (a === 'cancel-edit') { card.classList.remove('editing'); updateJobCard(card, job); }
  if (a === 'dismiss') updateJobCard(card, await api(`/api/jobs/${job.id}/dismiss`, { method: 'POST' }));
  if (a === 'approve') {
    const params = card.classList.contains('editing')
      ? Object.fromEntries([...card.querySelectorAll('[data-f]')].map((f) => [f.dataset.f, f.dataset.f === 'duration_seconds' ? Number(f.value) : f.value]))
      : undefined;
    e.target.disabled = true;
    try {
      const updated = await api(`/api/jobs/${job.id}/approve`, { method: 'POST', body: JSON.stringify({ params }) });
      card.classList.remove('editing');
      setCredits(updated.credits_left);
      updateJobCard(card, updated);
    } catch (err) { toast(err.message); e.target.disabled = false; }
  }
});

function poll(jobId) {
  if (state.polling.has(jobId)) return;
  state.polling.add(jobId);
  const tick = async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      document.querySelectorAll(`.card[data-job="${jobId}"]`).forEach((c) => updateJobCard(c, job));
      if (job.status === 'running') return setTimeout(tick, 1500);
      setCredits(job.credits_left);
    } catch {}
    state.polling.delete(jobId);
  };
  setTimeout(tick, 1500);
}

// ---------- API ----------
async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401) { showLogin(); throw new Error('Please log in'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function setCredits(n) {
  if (n === undefined || n === null) return;
  $('#credits').textContent = `${n} credits`;
  $('#creditsSide').textContent = n;
}

async function refreshState() {
  try {
    const s = await api('/api/state');
    setCredits(s.credits);
    state.sound = s.sound;
    $('#mockPill').hidden = !s.mock;
    if (!s.mock) refreshEngine();
    renderRecents(s.sessions, s.projects || []);
    $('#fileInput').accept = s.accept || '';
  } catch {}
}

// Engine pill: is the Mac reachable, and is the tunnel locked behind Cloudflare Access?
let engineChecked = 0;
async function refreshEngine(force = false) {
  if (!force && Date.now() - engineChecked < 60000) return;
  engineChecked = Date.now();
  const pill = $('#enginePill');
  try {
    const e = await api(`/api/engine${force ? '?fresh=1' : ''}`);
    const unlocked = !e.private && (!e.token || e.locked === false);
    pill.hidden = false;
    pill.className = `pill engine ${unlocked ? 'bad' : e.reachable ? 'ok' : 'off'}`;
    pill.textContent = unlocked ? 'Engine unlocked' : e.reachable ? 'Engine online' : 'Engine offline';
    pill.title = unlocked
      ? 'ComfyUI is reachable without the Cloudflare Access token. Generation is blocked until the tunnel is locked (build guide, Step 7).'
      : e.reachable ? 'Your Mac is connected.' : e.error || 'Your Mac is not reachable. Wake it and start ComfyUI and the tunnel.';
  } catch { pill.hidden = true; }
}

// Recents: chats and films together, newest first, filterable.
function renderRecents(sessions, films = []) {
  const filter = store.get('recentsFilter', 'all');
  const rows = [
    ...(filter !== 'films' ? sessions.map((s) => ({ ...s, type: 'chat' })) : []),
    ...(filter !== 'chats' ? films.map((f) => ({ ...f, type: 'film' })) : [])
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  $('#recents').innerHTML = rows.map((r) => `<li data-id="${r.id}" data-type="${r.type}" class="${r.id === state.sessionId ? 'active' : ''}"><span class="ri">${r.type === 'film' ? '▤' : '✦'}</span><span>${esc(r.title)}</span>${r.type === 'chat' ? `<button class="del" data-del="${r.id}" title="Delete">✕</button>` : ''}</li>`).join('')
    || `<li class="recents-empty">${filter === 'films' ? 'No films yet' : 'No chats yet'}</li>`;
}
$('#recents').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    await api(`/api/sessions/${del.dataset.del}`, { method: 'DELETE' });
    if (del.dataset.del === state.sessionId) goHome();
    return refreshState();
  }
  const li = e.target.closest('li[data-id]');
  if (li) li.dataset.type === 'film' ? openFilm(li.dataset.id) : openSession(li.dataset.id);
  $('#sidebar').classList.remove('open');
});

// ---------- send / stream ----------
async function send() {
  const text = input.value.trim();
  if (!text && !state.attachments.length) return;
  if (state.attachments.some((a) => a.status === 'uploading')) {
    sendBtn.disabled = true;
    await Promise.all(state.attachments.map((a) => a.promise));
  }
  const failed = state.attachments.filter((a) => a.status === 'error');
  if (failed.length) toast(`${failed.length} file${failed.length > 1 ? 's' : ''} could not be uploaded and ${failed.length > 1 ? 'were' : 'was'} left out`);
  const ready = state.attachments.filter((a) => a.status === 'ready' && a.assetId);
  if (!text && !ready.length) { updateSend(); return; }
  const assetIds = ready.map((a) => a.assetId);
  const shown = ready.map((a) => ({ id: a.assetId, kind: a.kind, name: a.name }));
  input.value = ''; state.attachments = []; renderAttachments(); autosize();

  if (!state.sessionId) { msgs.innerHTML = ''; $('#sessionTitle').textContent = 'New chat'; }
  placeComposer(true);
  renderUser(text, shown);
  const box = newAssistant();
  let pending = pendingEl();
  box.append(pending);
  scroll(true);

  const controller = new AbortController();
  state.running = controller;
  updateSend();

  let thinking = null, textEl = null, textBuf = '', drafting = null, raf = 0;
  const flushText = () => { raf = 0; if (textEl) textEl.innerHTML = md(textBuf); scroll(); };
  const clearPending = () => { pending?.remove(); pending = null; };

  const handlers = {
    session: (d) => {
      if (!state.sessionId) {
        state.sessionId = d.id;
        history.pushState({}, '', sessionUrl(d.id));
        $('#sessionTitle').textContent = d.title || 'Untitled session';
        refreshState();
      }
    },
    library_pending: (d) => { if (pending) pending.querySelector('span:last-child').textContent = `Filing ${d.count} file${d.count > 1 ? 's' : ''} in the asset library...`; },
    library: (part) => { box.insertBefore(libraryCard(part), pending || null); scroll(); },
    thinking_start: () => { clearPending(); thinking = thinkingEl(); box.append(thinking); scroll(); },
    thinking: (d) => { const t = $('.think-text', thinking); t.textContent += d.text; scroll(); },
    thinking_end: (d) => { finishThinking(thinking, d.seconds); thinking = null; },
    tool_drafting: () => { clearPending(); drafting = draftingCard(); box.append(drafting); scroll(); },
    tool_card: (job) => {
      clearPending();
      const card = jobCard(job);
      drafting ? drafting.replaceWith(card) : box.append(card);
      drafting = null;
      if (job.status === 'running') poll(job.id);
      scroll();
    },
    text_start: () => { clearPending(); textBuf = ''; textEl = document.createElement('div'); textEl.className = 'md'; box.append(textEl); },
    text: (d) => { textBuf += d.text; if (!raf) raf = requestAnimationFrame(flushText); },
    title: (d) => { $('#sessionTitle').textContent = d.title; document.title = `${d.title} · 925 Cinematic Studios`; refreshState(); },
    done: (d) => setCredits(d.credits),
    error: (d) => { clearPending(); const el = document.createElement('div'); el.className = 'error-line'; el.textContent = d.message; box.append(el); }
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, text, assetIds, model: state.model, approval: state.approval, quality: state.quality }),
      signal: controller.signal
    });
    if (res.status === 401) { showLogin(); throw new Error('Please log in'); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = 'message', data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data && handlers[ev]) handlers[ev](JSON.parse(data));
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') handlers.error({ message: err.message });
  } finally {
    if (raf) flushText();
    clearPending();
    if (thinking) finishThinking(thinking, 0);
    drafting?.remove();
    if (controller.signal.aborted) {
      const el = document.createElement('div'); el.className = 'card-status'; el.textContent = 'Stopped'; box.append(el);
    }
    state.running = null;
    updateSend();
    input.focus();
  }
}

function stop() { state.running?.abort(); }

// ---------- sessions ----------
async function openSession(id, push = true) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionId = s.id;
    if (push) history.pushState({}, '', sessionUrl(s.id));
    $('#sessionTitle').textContent = s.title;
    document.title = `${s.title} · 925 Cinematic Studios`;
    msgs.innerHTML = '';
    for (const entry of s.display) {
      if (entry.role === 'user') { renderUser(entry.text, entry.assets || [], entry.attachments || []); continue; }
      const box = newAssistant();
      for (const p of entry.parts) {
        if (p.type === 'thinking' && p.text.trim()) box.append(thinkingEl(p.text, true, p.seconds || 1));
        if (p.type === 'text') { const el = document.createElement('div'); el.className = 'md'; el.innerHTML = md(p.text); box.append(el); }
        if (p.type === 'job' && s.jobs[p.jobId]) box.append(jobCard(s.jobs[p.jobId]));
        if (p.type === 'library') box.append(libraryCard(p));
      }
    }
    placeComposer(true);
    scroll(true);
    refreshState();
  } catch { goHome(); }
}

function goHome(push = true) {
  stop();
  state.sessionId = null;
  if (push) history.pushState({}, '', '/');
  msgs.innerHTML = '';
  $('#sessionTitle').textContent = '';
  document.title = '925 Cinematic Studios · AI film studio';
  placeComposer(false);
  refreshState();
  loadExplore();
  input.focus();
}

$('#newChat').onclick = () => { goHome(); $('#sidebar').classList.remove('open'); };
// ---------- pages: Script to Film, Gallery ----------
function leaveChat() {
  stop();
  state.sessionId = null;
  msgs.innerHTML = '';
  $('#sessionTitle').textContent = '';
}
async function openStudioList(push = true) {
  leaveChat();
  if (push) history.pushState({}, '', '/?view=studio');
  document.title = 'Script to Film · 925 Cinematic Studios';
  showPage('studioList');
  try { await studio.renderList(); refreshState(); } catch (e) { toast(e.message); }
}
async function openFilm(id, push = true) {
  leaveChat();
  showPage('studio');
  try {
    const p = await studio.open(id);
    if (push) history.pushState({}, '', `/?p=${id}`);
    document.title = `${p.title} · 925 Cinematic Studios`;
  } catch (e) { toast(e.message); openStudioList(push); }
}
async function openAssets(push = true, character = null) {
  leaveChat();
  if (push) history.pushState({}, '', `/?view=assets${character ? `&character=${character}` : ''}`);
  document.title = 'Assets · 925 Cinematic Studios';
  showPage('assets');
  try { await library.show({ character }); } catch (e) { toast(e.message); }
}
const sessionUrl = (id) => `/?sessionId=${id}&tab=generations`;
async function openGallery(push = true) {
  leaveChat();
  if (push) history.pushState({}, '', '/?view=gallery');
  document.title = 'Gallery · 925 Cinematic Studios';
  showPage('gallery');
  try { await studio.renderGallery(); } catch (e) { toast(e.message); }
}
function route(push = false) {
  const q = new URLSearchParams(location.search);
  if (q.get('p')) return openFilm(q.get('p'), push);
  if (q.get('view') === 'studio') return openStudioList(push);
  if (q.get('view') === 'gallery') return openGallery(push);
  if (q.get('view') === 'assets') return openAssets(push, q.get('character'));
  if (q.get('sessionId') || q.get('s')) return openSession(q.get('sessionId') || q.get('s'), push);
  return goHome(push);
}
studio.init({ api, toast, setCredits });
library.init({ api, toast, setCredits, showLogin, navigate: (character) => openAssets(true, character) });
$('#enginePill').onclick = () => refreshEngine(true);
document.addEventListener('oav:open-film', (e) => openFilm(e.detail));
$('#newFilm').onclick = async () => { try { openFilm(await studio.newFilm()); } catch (e) { toast(e.message); } };
$('#studioBack').onclick = () => openStudioList();

document.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  if (a.dataset.nav === 'studio') return openStudioList();
  if (a.dataset.nav === 'gallery') return openGallery();
  if (a.dataset.nav === 'assets') return openAssets();
  if (a.dataset.nav === 'agent') {
    // Agent: back to the chat you were in, else your latest chat, else a new one.
    const last = $('#recents li[data-type="chat"]');
    return last ? openSession(last.dataset.id) : goHome();
  }
  goHome();
}));
addEventListener('popstate', () => route(false));
$('#closeBanner').onclick = () => { $('#banner').remove(); store.set('bannerClosed', true); };
if (store.get('bannerClosed', false)) $('#banner').remove();
// ---------- home: tool row and the explore strip ----------
const STARTERS = [
  ['Character sheet', 'Create a character lineup model sheet for an original '],
  ['Storyboard', 'Storyboard a 6-shot opening scene for '],
  ['Key art', 'Design key art / a poster for '],
  ['Animate an image', 'Animate this image into a 4 second clip with sound: '],
  ['Product shot', 'Make a clean studio product shot of ']
];
$('#toolRow').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.go === 'studio') return openStudioList();
  if (b.dataset.go === 'assets') return openAssets();
  if (b.dataset.more) return openMenu(b, `<div class="pop-label">Start with</div>${STARTERS.map(([l, f]) => `<button class="pop-item" data-pop="fill" data-fill="${esc(f)}"><span>${l}</span></button>`).join('')}`, 'below');
  if (b.dataset.fill) { input.value = b.dataset.fill; input.focus(); autosize(); updateSend(); }
});

const EXPLORE = {
  'Marketing campaigns': [['Launch film', 'A 15 second launch film for a new running shoe: rain-soaked city at night, slow-motion splashes, bold type'], ['Product hero', 'Hero shot of a glass perfume bottle on black sand, golden rim light, slow orbit'], ['Social teaser', 'Vertical 9:16 teaser for a coffee brand: steam curling in morning light, cozy kitchen']],
  Movies: [['Opening shot', 'Opening shot of a lone wanderer crossing a windswept grass field at dusk, handheld, 35mm film grain'], ['Misty forest', 'A misty pine forest at dawn, a tiny figure walking between the trees, slow push-in'], ['Armored hero', 'Close-up portrait of a young warrior in silver armor, snow falling, soft light'], ['Night chase', 'A neon-lit alley chase in the rain, low angle, fast dolly']],
  'Social media': [['Day in the life', 'A cozy day-in-the-life montage, warm tones, vertical 9:16'], ['Before / after', 'A before and after room makeover reveal, quick whip pan'], ['Recipe clip', 'Top-down recipe clip: pasta tossed in a pan, steam, natural light']],
  'Educational content': [['Explainer', 'An animated explainer of how a volcano erupts, clean infographic style'], ['History scene', 'A recreation of an ancient Roman market at morning, wide establishing shot'], ['Space tour', 'A slow fly-by of Saturn and its rings, documentary style']],
  'Experimental art': [['Liquid chrome', 'Liquid chrome shapes morphing in a white void, macro lens'], ['Paper world', 'A city made of folded paper unfolding into a forest, stop-motion feel'], ['Dream loop', 'A surreal looping dream: staircases into clouds, soft pastel palette']],
  Other: [['Pet portrait', 'A regal oil-painting style portrait of a dog as a 17th century admiral'], ['Music visual', 'An abstract audio-reactive visual of glowing particles for a lo-fi track'], ['Travel postcard', 'A sunny Mediterranean harbor postcard, boats bobbing, slow pan']]
};
let exploreTab = store.get('exploreTab', 'Movies');
let galleryItems = [];
function renderExplore() {
  $('#exploreTabs').innerHTML = Object.keys(EXPLORE).map((t) => `<button class="${t === exploreTab ? 'on' : ''}" data-tab="${esc(t)}">${t}</button>`).join('');
  const own = exploreTab === 'Movies' ? galleryItems.slice(0, 6) : [];
  $('#exploreStrip').innerHTML = [
    ...own.map((g) => `<button class="ex-card media" data-fill="${esc(g.prompt || g.title)}" title="${esc(g.title)}">${g.kind === 'video' ? `<video src="${g.url}#t=0.1" muted loop playsinline preload="metadata"></video>` : `<img src="${g.url}" alt="" loading="lazy">`}<span>${esc(g.title)}</span></button>`),
    ...EXPLORE[exploreTab].map(([title, prompt], i) => `<button class="ex-card" data-fill="${esc(prompt)}" style="--h:${(i * 57 + title.length * 23) % 360}"><b>${esc(title)}</b><small>${esc(prompt)}</small></button>`)
  ].join('');
}
$('#exploreTabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]')?.dataset.tab;
  if (!t) return;
  exploreTab = t; store.set('exploreTab', t); renderExplore();
});
$('#exploreStrip').addEventListener('click', (e) => {
  const c = e.target.closest('[data-fill]');
  if (!c) return;
  input.value = c.dataset.fill; input.focus(); autosize(); updateSend();
});
$('#exploreStrip').addEventListener('mouseover', (e) => e.target.closest('.ex-card')?.querySelector('video')?.play().catch(() => {}));
$('#exploreStrip').addEventListener('mouseout', (e) => e.target.closest('.ex-card')?.querySelector('video')?.pause());
$('#stripNext').onclick = () => $('#exploreStrip').scrollBy({ left: 420, behavior: 'smooth' });
async function loadExplore() {
  try { galleryItems = (await api('/api/gallery')).items; } catch {}
  renderExplore();
}
renderExplore();

// New Chat dropdown and the Recents header buttons.
$('#newMenu').onclick = (e) => openMenu(e.currentTarget, `<button class="pop-item" data-pop="new-chat"><span>New chat<small>Talk to the agent</small></span></button>
  <button class="pop-item" data-pop="new-film"><span>New film<small>Script to Film: upload a script</small></span></button>
  <button class="pop-item" data-pop="new-upload"><span>Upload to asset library<small>Images, documents, audio</small></span></button>`, 'below-left');
$('#recentsNew').onclick = () => goHome();
$('#recentsFilter').onclick = (e) => {
  const f = store.get('recentsFilter', 'all');
  openMenu(e.currentTarget, `<div class="pop-label">Show</div>${[['all', 'Everything'], ['chats', 'Chats'], ['films', 'Films']].map(([k, l]) => `<button class="pop-item" data-pop="filter-${k}"><span>${l}</span>${check(f === k)}</button>`).join('')}`, 'below');
};
$('#openSidebar').onclick = () => $('#sidebar').classList.add('open');
$('#closeSidebar').onclick = () => $('#sidebar').classList.remove('open');

// ---------- sketch ----------
const canvas = $('#sketchCanvas');
const ctx = canvas.getContext('2d');
let color = '#111111', drawing = false;
const COLORS = ['#111111', '#e5484d', '#f5a623', '#30a46c', '#0091ff', '#7c5cff', '#ffffff'];
$('#swatches').innerHTML = COLORS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === color ? 'on' : ''}"></button>`).join('');
$('#swatches').onclick = (e) => {
  const c = e.target.dataset.c; if (!c) return;
  color = c; [...$('#swatches').children].forEach((b) => b.classList.toggle('on', b.dataset.c === c));
};
function clearSketch() { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
function openSketch() { clearSketch(); $('#sketchModal').hidden = false; }
const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
canvas.addEventListener('pointerdown', (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  ctx.lineTo(...pos(e)); ctx.strokeStyle = color; ctx.lineWidth = +$('#brush').value; ctx.lineCap = ctx.lineJoin = 'round'; ctx.stroke();
});
canvas.addEventListener('pointerup', () => { drawing = false; });
$('#sketchModal').addEventListener('click', (e) => {
  const a = e.target.dataset.sketch;
  if (a === 'close') $('#sketchModal').hidden = true;
  if (a === 'clear') clearSketch();
  if (a === 'use') {
    canvas.toBlob((blob) => addFiles([new File([blob], 'sketch.png', { type: 'image/png' })]), 'image/png');
    $('#sketchModal').hidden = true;
    if (!input.value) input.value = 'Turn my sketch into ';
    input.focus(); autosize();
  }
});

// ---------- login ----------
function showLogin() { $('#loginModal').hidden = false; $('#password').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#password').value }) });
  if (r.ok) { $('#loginModal').hidden = true; boot(); } else $('#loginErr').textContent = 'Wrong password';
});

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- boot ----------
function boot() {
  updateLabels(); updateSend();
  route(false);
}
boot();
