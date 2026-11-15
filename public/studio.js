// Script to Film: script -> shots -> clips on a timeline (script order) -> stitched film -> export.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

let api, toast, setCredits; // shared helpers from app.js
let project = null;          // latest server view of the open film
let shotSig = '';            // which shots are on screen (ids, in order)
let selected = null;
let pollTimer = 0;
let busy = false;            // a request that replaces the shot list is in flight

const el = {};
export function init(helpers) {
  ({ api, toast, setCredits } = helpers);
  for (const id of ['pTitle', 'pAspect', 'pQuality', 'pSound', 'soundField', 'pStyle', 'pScript', 'useAI', 'aiWrap', 'breakdown', 'uploadScript', 'scriptFile', 'scriptHint',
    'shots', 'shotsHint', 'generateAll', 'cancelQueue', 'addShot', 'preview', 'playerEmpty', 'player', 'filmHint', 'exFormat', 'exRes', 'pTransition',
    'exportBtn', 'exports', 'track', 'timeline', 'playhead', 'timelineHint', 'scriptPanel', 'filmGrid', 'galleryGrid']) el[id] = document.getElementById(id);
  wire();
}

// ---------- list of films ----------
export async function renderList() {
  const { projects = [] } = await api('/api/state');
  el.filmGrid.innerHTML = projects.length
    ? projects.map((p) => `<div class="film-card" data-open="${p.id}">
        <div class="film-poster">${p.poster ? `<video src="${p.poster}#t=0.1" muted preload="metadata" playsinline></video>` : '<span>No clips yet</span>'}</div>
        <div class="film-meta"><b>${esc(p.title)}</b><span>${p.clips} of ${p.shots} shots rendered</span></div>
        <button class="icon-btn film-del" data-del="${p.id}" title="Delete film">✕</button>
      </div>`).join('')
    : '<div class="empty">No films yet. Start one and upload your script.</div>';
}

export async function newFilm() {
  const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({}) });
  return p.id;
}

export async function renderGallery() {
  const { items } = await api('/api/gallery');
  el.galleryGrid.innerHTML = items.length
    ? items.map((i) => `<figure class="g-item">
        ${i.kind === 'video' ? `<video src="${i.url}#t=0.1" controls muted loop preload="metadata" playsinline></video>` : `<img src="${i.url}" alt="${esc(i.title)}" loading="lazy">`}
        <figcaption><span title="${esc(i.prompt)}">${esc(i.title)}</span><a href="${i.url}" download="${esc(i.filename)}">Download</a></figcaption>
      </figure>`).join('')
    : '<div class="empty">Nothing here yet. Generated images and clips show up in this gallery.</div>';
}

// ---------- one film ----------
export async function open(id) {
  close();
  project = await api(`/api/projects/${id}`);
  shotSig = '';
  selected = null;
  el.preview.removeAttribute('src');
  el.preview.dataset.url = '';
  el.useAI.checked = project.ai && localStorage.getItem('oav:useAI') !== '0';
  el.scriptPanel.open = !project.shots.length;
  render();
  return project;
}
export function close() {
  clearTimeout(pollTimer);
  pollTimer = 0;
  project = null;
  el.preview?.pause();
}

const jobState = (s) => s.job?.status;
const isBusy = (s) => ['queued', 'running'].includes(jobState(s));
const needsPoll = () => project && (project.shots.some(isBusy) || project.preview?.status === 'building' || project.exports.some((e) => e.status === 'running'));

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!needsPoll()) return;
  pollTimer = setTimeout(async () => {
    if (!project) return;
    const id = project.id;
    try {
      const fresh = await api(`/api/projects/${id}`);
      if (project?.id === id && !busy) { project = fresh; render(); }
    } catch { schedulePoll(); }
  }, 1500);
}

function apply(view) { project = view; render(); }

async function call(path, opts) {
  const id = project.id;
  const view = await api(`/api/projects/${id}${path}`, opts);
  if (project?.id === id) apply(view);
  return view;
}
const post = (path, body = {}) => call(path, { method: 'POST', body: JSON.stringify(body) });
const patch = (path, body) => call(path, { method: 'PATCH', body: JSON.stringify(body) });

function render() {
  const p = project;
  setCredits(p.credits);
  // Settings: don't overwrite a field the user is typing in.
  for (const [node, v] of [[el.pTitle, p.title], [el.pStyle, p.style], [el.pScript, p.script]]) if (document.activeElement !== node) node.value = v;
  el.pAspect.value = p.aspect_ratio;
  el.pQuality.value = p.quality;
  el.pTransition.value = p.transition;
  el.pSound.value = p.sound ? 'on' : 'off';
  el.soundField.hidden = !p.soundAvailable;
  el.shots.classList.toggle('no-sound', !(p.sound && p.soundAvailable));
  el.exRes.options[0].textContent = `Source (${p.aspect_ratio === '1:1' ? '640' : '480'}p)`;
  el.useAI.disabled = !p.ai;
  el.aiWrap.title = p.ai ? 'Claude splits the script into shots and writes a video prompt for each' : 'Needs ANTHROPIC_API_KEY on the server (off in mock mode). Without it the script is split locally.';
  el.aiWrap.classList.toggle('off', !p.ai);
  el.scriptHint.textContent = p.script ? `${p.script.trim().split(/\s+/).length} words` : '';

  const sig = p.shots.map((s) => s.id).join(',');
  if (sig !== shotSig) { shotSig = sig; renderShots(); }
  updateShots();
  renderTimeline();
  renderFilm();
  renderExports();
  schedulePoll();
}

function renderShots() {
  el.shots.innerHTML = project.shots.length
    ? project.shots.map((s, i) => `<div class="shot" data-shot="${s.id}">
        <div class="shot-n">${i + 1}</div>
        <div class="shot-main">
          <input class="shot-heading" data-f="heading" value="${esc(s.heading)}" maxlength="90" aria-label="Shot name" />
          ${s.text && s.text !== s.prompt ? `<div class="shot-script" title="${esc(s.text)}">${esc(s.text)}</div>` : ''}
          <textarea class="shot-prompt" data-f="prompt" rows="3" maxlength="900" placeholder="Describe what the camera sees: subject, action, camera move, setting, light.">${esc(s.prompt)}</textarea>
          <label class="shot-sound"><span>♪</span><input data-f="sound" value="${esc(s.sound || '')}" maxlength="300" placeholder="Sound: ambience, effects, music mood (blank = from the picture)" aria-label="Sound for this shot" /></label>
          <div class="shot-bar">
            <select data-f="duration_seconds" aria-label="Clip length">${[2, 3, 4, 5].map((d) => `<option value="${d}" ${d === s.duration_seconds ? 'selected' : ''}>${d}s</option>`).join('')}</select>
            <span class="shot-status"></span>
            <span class="grow"></span>
            <button class="btn fit sm" data-a="gen"></button>
            <button class="icon-btn" data-a="remove" title="Remove shot">✕</button>
          </div>
        </div>
        <div class="shot-thumb"></div>
      </div>`).join('')
    : '<div class="empty">No shots yet. Add your script above and press “Break into shots”.</div>';
}

function statusHtml(s) {
  const j = s.job;
  if (!j) return s.clip ? '' : '<span class="st">Not rendered</span>';
  if (j.status === 'queued') return '<span class="st wait">Queued</span>';
  if (j.status === 'running') return `<span class="st run"><span class="spinner"></span>${j.phase === 'sound' ? 'Adding sound' : 'Rendering'} ${Math.round((j.progress || 0) * 100)}%</span>`;
  if (j.status === 'done' && j.soundError) return `<span class="st err" title="${esc(j.soundError)}">On timeline, silent: sound failed</span>`;
  if (j.status === 'done' && j.sound) return '<span class="st ok">On timeline · with sound</span>';
  if (j.status === 'failed') return `<span class="st err" title="${esc(j.error)}">Failed: ${esc(j.error)}</span>`;
  if (j.status === 'cancelled') return '<span class="st">Cancelled</span>';
  return '<span class="st ok">On timeline</span>';
}

function updateShots() {
  const p = project;
  for (const s of p.shots) {
    const card = el.shots.querySelector(`[data-shot="${s.id}"]`);
    if (!card) continue;
    card.classList.toggle('selected', s.id === selected);
    $('.shot-status', card).innerHTML = statusHtml(s);
    const gen = $('[data-a="gen"]', card);
    gen.disabled = isBusy(s);
    gen.textContent = isBusy(s) ? 'Rendering…' : `${s.clip ? 'Regenerate' : 'Generate'} · ${s.credits} cr`;
    gen.classList.toggle('btn-primary', !s.clip && !isBusy(s));
    for (const f of card.querySelectorAll('[data-f]')) if (document.activeElement !== f && String(f.value) !== String(s[f.dataset.f])) f.value = s[f.dataset.f];
    const thumb = $('.shot-thumb', card);
    if (thumb.dataset.clip !== (s.clip || '')) {
      thumb.dataset.clip = s.clip || '';
      thumb.innerHTML = s.clip
        ? `<video src="${s.clip}#t=0.1" muted loop playsinline preload="metadata"></video><a class="dl" href="${s.clip}" download="shot-${String(p.shots.indexOf(s) + 1).padStart(2, '0')}.mp4" title="Download this clip">↓</a>`
        : '';
    }
  }
  const todo = p.shots.filter((s) => !s.clip && !isBusy(s) && s.prompt.trim());
  const cost = todo.reduce((a, s) => a + s.credits, 0);
  const queued = p.shots.filter((s) => jobState(s) === 'queued').length;
  el.generateAll.disabled = !todo.length;
  el.generateAll.textContent = todo.length ? `Generate ${todo.length === p.shots.length ? 'all' : `${todo.length} remaining`} · ${cost} cr` : p.shots.some(isBusy) ? 'Rendering…' : 'All shots rendered';
  el.cancelQueue.hidden = !queued;
  el.cancelQueue.textContent = `Cancel ${queued} queued`;
  el.addShot.hidden = !p.shots.length && !p.script;
  const total = p.shots.reduce((a, s) => a + s.duration_seconds, 0);
  el.shotsHint.textContent = p.shots.length ? `${p.shots.length} shots · ${fmtTime(total)} · ${p.engine}` : '';
}

// ---------- timeline ----------
const PX_PER_SEC = 34;
function renderTimeline() {
  const p = project;
  const html = p.shots.map((s, i) => {
    const st = isBusy(s) ? jobState(s) : s.clip ? 'done' : jobState(s) === 'failed' ? 'failed' : 'empty';
    const prog = jobState(s) === 'running' ? `<i class="tl-prog" style="width:${Math.round((s.job.progress || 0) * 100)}%"></i>` : '';
    return `<button class="tl-clip ${st} ${s.id === selected ? 'selected' : ''}" data-shot="${s.id}" style="width:${Math.max(64, s.duration_seconds * PX_PER_SEC)}px" title="${esc(s.heading)}">
      ${s.clip ? `<video src="${s.clip}#t=0.1" muted preload="metadata" playsinline tabindex="-1"></video>` : ''}
      <span class="tl-n">${i + 1}</span><span class="tl-name">${esc(s.heading)}</span>
      <span class="tl-state">${{ queued: 'Queued', running: s.job?.phase === 'sound' ? 'Sound' : 'Rendering', failed: 'Failed', empty: 'Empty', done: `${s.clip && s.job?.sound ? '♪ ' : ''}${s.duration_seconds}s` }[st]}</span>${prog}
    </button>`;
  });
  // Only touch clips that changed, so thumbnails don't reload on every poll.
  const nodes = [...el.track.querySelectorAll('.tl-clip')];
  const same = nodes.length === html.length && html.length && nodes.every((n, i) => n.dataset.shot === p.shots[i].id);
  if (!same) {
    el.track.innerHTML = html.join('') || '<div class="tl-empty">Your shots will line up here in script order.</div>';
    el.track.querySelectorAll('.tl-clip').forEach((n, i) => { n._html = html[i]; });
  } else {
    nodes.forEach((n, i) => {
      if (n._html === html[i]) return;
      const t = document.createElement('template');
      t.innerHTML = html[i];
      const fresh = t.content.firstElementChild;
      fresh._html = html[i];
      n.replaceWith(fresh);
    });
  }
  const done = p.shots.filter((s) => s.clip).length;
  el.timelineHint.textContent = p.shots.length ? `${done} of ${p.shots.length} clips in script order` : '';
  movePlayhead();
}

function movePlayhead() {
  const segs = project?.preview?.segments;
  const t = el.preview.currentTime;
  if (!segs?.length || !el.preview.dataset.url) { el.playhead.hidden = true; return; }
  // Find the clip under the playhead; during a crossfade the later clip wins.
  let seg = segs[0];
  for (const s of segs) if (t >= s.start) seg = s;
  const node = el.track.querySelector(`[data-shot="${seg.shotId}"]`);
  if (!node) { el.playhead.hidden = true; return; }
  const frac = Math.min(1, Math.max(0, (t - seg.start) / (seg.duration || 1)));
  el.playhead.hidden = false;
  el.playhead.style.left = `${node.offsetLeft + frac * node.offsetWidth}px`;
}

function select(id, { seek = true, scroll = true } = {}) {
  selected = id;
  el.shots.querySelectorAll('.shot').forEach((c) => c.classList.toggle('selected', c.dataset.shot === id));
  renderTimeline();
  if (scroll) el.shots.querySelector(`[data-shot="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const seg = project.preview?.segments?.find((s) => s.shotId === id);
  if (seek && seg && el.preview.dataset.url) { el.preview.currentTime = seg.start + 0.02; movePlayhead(); }
}

// ---------- stitched film ----------
function renderFilm() {
  const pv = project.preview;
  const url = pv?.url || '';
  if (el.preview.dataset.url !== url) {
    const at = el.preview.currentTime || 0;
    const wasPlaying = !el.preview.paused;
    el.preview.dataset.url = url;
    if (url) {
      el.preview.src = url;
      el.preview.addEventListener('loadedmetadata', () => {
        el.preview.currentTime = Math.min(at, Math.max(0, el.preview.duration - 0.1));
        if (wasPlaying) el.preview.play().catch(() => {});
      }, { once: true });
    } else el.preview.removeAttribute('src');
  }
  el.player.classList.toggle('has-film', !!url);
  el.player.style.aspectRatio = project.aspect_ratio.replace(':', ' / ');
  const done = project.shots.filter((s) => s.clip).length;
  el.playerEmpty.textContent = pv?.status === 'building' ? 'Stitching your clips…' : 'Clips appear here, stitched in script order, as they finish.';
  el.filmHint.innerHTML = !pv ? ''
    : pv.status === 'building' ? '<span class="spinner"></span> Stitching…'
    : pv.status === 'failed' ? `<span class="st err">Stitch failed: ${esc(pv.error)}</span>`
    : `${pv.segments.length} of ${project.shots.length} shots · ${fmtTime(pv.duration)}${pv.audio ? ' · with sound' : ''}${done < project.shots.length ? ' · partial' : ''}`;
  el.exportBtn.disabled = !done;
}

function renderExports() {
  el.exports.innerHTML = project.exports.map((e) => {
    const what = `${esc(e.label || e.format)} · ${e.resolution === 'source' ? 'source size' : e.resolution}${e.clips < e.shots ? ` · ${e.clips} of ${e.shots} shots` : ''}`;
    if (e.status === 'running') return `<div class="export"><div><span>${what}</span><div class="progress"><div style="width:${Math.round((e.progress || 0) * 100)}%"></div></div></div><span class="st run">${Math.round((e.progress || 0) * 100)}%</span></div>`;
    if (e.status === 'failed') return `<div class="export"><span>${what}</span><span class="st err" title="${esc(e.error)}">Failed</span></div>`;
    return `<div class="export"><span>${what} · ${fmtTime(e.duration)} · ${e.audio ? 'with sound' : 'silent'} · ${fmtSize(e.size)}</span><a class="btn fit sm btn-primary" href="${e.url}" download>Download</a></div>`;
  }).join('');
}

// ---------- events ----------
function wire() {
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

  el.filmGrid.addEventListener('click', guard(async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!confirm('Delete this film, its timeline and exports?')) return;
      await api(`/api/projects/${del.dataset.del}`, { method: 'DELETE' });
      return renderList();
    }
    const card = e.target.closest('[data-open]');
    if (card) document.dispatchEvent(new CustomEvent('oav:open-film', { detail: card.dataset.open }));
  }));

  const saveSetting = (node, key) => node.addEventListener('change', guard(() => project && patch('', { [key]: node.value })));
  saveSetting(el.pTitle, 'title');
  saveSetting(el.pStyle, 'style');
  saveSetting(el.pScript, 'script');
  saveSetting(el.pAspect, 'aspect_ratio');
  saveSetting(el.pQuality, 'quality');
  saveSetting(el.pTransition, 'transition');
  el.pSound.addEventListener('change', guard(() => project && patch('', { sound: el.pSound.value === 'on' })));
  el.useAI.addEventListener('change', () => localStorage.setItem('oav:useAI', el.useAI.checked ? '1' : '0'));

  el.uploadScript.onclick = () => el.scriptFile.click();
  el.scriptFile.addEventListener('change', guard(async () => {
    const file = el.scriptFile.files[0];
    el.scriptFile.value = '';
    if (!file) return;
    if (file.size > 25e6) throw new Error('That file is over 25 MB');
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(file); });
    const { text } = await api('/api/script/extract', { method: 'POST', body: JSON.stringify({ name: file.name, dataUrl }) });
    el.pScript.value = text;
    const body = { script: text };
    if (/^Untitled film$/i.test(project.title)) body.title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    await patch('', body);
    toast(`Loaded ${file.name}. Press “Break into shots”.`);
  }));

  el.breakdown.addEventListener('click', guard(async () => {
    if (!el.pScript.value.trim()) throw new Error('Paste or upload a script first');
    if (project.shots.some((s) => s.clip || isBusy(s)) && !confirm('This replaces the current shots and removes their clips from the timeline. Continue?')) return;
    const label = el.breakdown.textContent;
    busy = true;
    el.breakdown.disabled = true;
    el.breakdown.innerHTML = `<span class="spinner"></span> ${el.useAI.checked && project.ai ? 'Writing shots…' : 'Splitting…'}`;
    try {
      const view = await post('/breakdown', { script: el.pScript.value, ai: el.useAI.checked });
      el.scriptPanel.open = false;
      toast(view.note || `${view.shots.length} shots, in script order`);
    } finally { busy = false; el.breakdown.disabled = false; el.breakdown.textContent = label; schedulePoll(); }
  }));

  el.generateAll.addEventListener('click', guard(() => post('/generate')));
  el.cancelQueue.addEventListener('click', guard(() => post('/cancel')));
  el.addShot.addEventListener('click', guard(async () => {
    await post('/shots', { after: selected });
    el.shots.querySelector('.shot:last-child .shot-prompt')?.focus();
  }));

  el.shots.addEventListener('change', guard(async (e) => {
    const f = e.target.closest('[data-f]');
    const card = e.target.closest('.shot');
    if (!f || !card) return;
    const value = f.dataset.f === 'duration_seconds' ? Number(f.value) : f.value;
    await patch(`/shots/${card.dataset.shot}`, { [f.dataset.f]: value });
  }));
  el.shots.addEventListener('click', guard(async (e) => {
    const card = e.target.closest('.shot');
    if (!card) return;
    const a = e.target.closest('[data-a]')?.dataset.a;
    const id = card.dataset.shot;
    if (a === 'gen') {
      // Send the fields as typed, in case the change event hasn't fired yet.
      const body = Object.fromEntries([...card.querySelectorAll('[data-f]')].map((f) => [f.dataset.f, f.dataset.f === 'duration_seconds' ? Number(f.value) : f.value]));
      return post(`/shots/${id}/generate`, body);
    }
    if (a === 'remove') return call(`/shots/${id}`, { method: 'DELETE' });
    if (!e.target.closest('input,textarea,select,a,button')) select(id, { scroll: false });
  }));
  el.shots.addEventListener('mouseover', (e) => e.target.closest('.shot-thumb')?.querySelector('video')?.play().catch(() => {}));
  el.shots.addEventListener('mouseout', (e) => e.target.closest('.shot-thumb')?.querySelector('video')?.pause());

  el.track.addEventListener('click', (e) => {
    const clip = e.target.closest('.tl-clip');
    if (clip) select(clip.dataset.shot);
  });
  el.preview.addEventListener('timeupdate', movePlayhead);
  el.preview.addEventListener('seeked', movePlayhead);

  el.exportBtn.addEventListener('click', guard(() => post('/exports', { format: el.exFormat.value, resolution: el.exRes.value })));
}
