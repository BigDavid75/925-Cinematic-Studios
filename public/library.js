// Asset library: every uploaded image, document and audio file, filed by character.
import { esc, fmtSize, fmtDur, uploadFile, assetTile, KIND_ICON } from './files.js';

const $ = (s, el = document) => el.querySelector(s);
let api, toast, setCredits, showLogin, navigate;
let useInChat = () => {};
export const onUseInChat = (fn) => { useInChat = fn; };

const view = { character: null, kind: '', q: '' }; // character: null = all, 'none' = unassigned, or a chr_ id
let assets = [];
let characters = [];
let accept = '';
let ai = false;
let uploading = []; // { name, kind, progress }

export function init(helpers) {
  ({ api, toast, setCredits, showLogin, navigate } = helpers);
  wire();
}

async function load() {
  const q = new URLSearchParams();
  if (view.kind) q.set('kind', view.kind);
  if (view.character) q.set('character', view.character);
  if (view.q) q.set('q', view.q);
  const r = await api(`/api/assets?${q}`);
  assets = r.assets;
  characters = r.characters;
  accept = r.accept;
  ai = r.ai;
}

export async function show({ character = null } = {}) {
  view.character = character;
  await load();
  render();
}

const charName = (id) => characters.find((c) => c.id === id)?.name || 'Unknown';

function render() {
  // Characters column
  const all = characters.reduce((n, c) => n, 0);
  $('#libChars').innerHTML = [
    `<li class="${!view.character ? 'on' : ''}" data-char=""><span class="lc-avatar all">◫</span><span class="lc-name">All assets</span></li>`,
    `<li class="${view.character === 'none' ? 'on' : ''}" data-char="none" data-drop="none"><span class="lc-avatar none">?</span><span class="lc-name">Unassigned</span></li>`,
    ...characters.map((c) => `<li class="${view.character === c.id ? 'on' : ''}" data-char="${c.id}" data-drop="${c.id}">
      <span class="lc-avatar">${c.avatar ? `<img src="${c.avatar}" alt="">` : esc(c.name[0] || '?')}</span>
      <span class="lc-name">${esc(c.name)}<small>${[c.counts.image && `${c.counts.image} img`, c.counts.document && `${c.counts.document} doc`, c.counts.audio && `${c.counts.audio} audio`].filter(Boolean).join(' · ') || 'No assets yet'}</small></span></li>`)
  ].join('') + (characters.length ? '' : '<li class="lc-empty">Characters appear here when you upload a character list or create one with +.</li>');
  void all;

  // Header: the selected character can be renamed, described and deleted.
  const c = characters.find((x) => x.id === view.character);
  $('#libHead').innerHTML = c
    ? `<div class="lh-char"><span class="lc-avatar big">${c.avatar ? `<img src="${c.avatar}" alt="">` : esc(c.name[0])}</span>
        <div class="lh-fields"><input class="lh-name" data-cf="name" value="${esc(c.name)}" maxlength="60" aria-label="Character name"><textarea class="lh-desc" data-cf="description" rows="2" maxlength="600" placeholder="Describe the character: look, personality, role. The agent uses this to keep them consistent.">${esc(c.description)}</textarea></div>
        <button class="btn fit sm" data-lh="chat">Use in chat</button><button class="icon-btn" data-lh="delete" title="Delete character">🗑</button></div>`
    : `<div class="lh-title"><h2>${view.character === 'none' ? 'Unassigned assets' : 'Asset library'}</h2><p>${view.character === 'none' ? 'Files not filed under a character yet. Drag one onto a character, or press Auto-assign.' : 'Everything you upload in chat or here: images, documents and audio, filed by character. Drag a file onto a character to assign it.'}</p></div>`;

  // Kind filter
  $('#libKinds').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.kind === view.kind));
  $('#libAssign').hidden = !assets.some((a) => !a.characterIds.length) && view.character !== 'none';
  $('#libAssign').title = ai ? 'Claude looks at each unassigned file and files it under the right character' : 'Match unassigned files to characters by name (AI matching needs ANTHROPIC_API_KEY)';

  // Grid
  const pending = uploading.map((u) => `<div class="lib-card uploading">${assetTile(u, { pending: u })}<div class="lc-meta"><b>${esc(u.name)}</b><small>Uploading ${Math.round(u.progress * 100)}%</small></div></div>`).join('');
  $('#libGrid').innerHTML = pending + (assets.length
    ? assets.map((a) => `<div class="lib-card" draggable="true" data-id="${a.id}">
        <button type="button" class="lc-open" data-open="${a.id}">${a.kind === 'image' ? `<img src="${a.thumb}" alt="" loading="lazy">` : `<span class="lc-file kind-${a.kind}">${KIND_ICON[a.kind]}<em>${esc(a.ext.toUpperCase())}</em></span>`}</button>
        <div class="lc-meta"><b title="${esc(a.name)}">${esc(a.name)}</b><small>${esc(meta(a))}</small></div>
        <div class="lc-chars">${a.characterIds.map((id) => `<span class="chip">${esc(charName(id))}</span>`).join('') || '<span class="chip ghost">Unassigned</span>'}</div>
      </div>`).join('')
    : uploading.length ? '' : `<div class="empty lib-empty">${view.q || view.kind ? 'Nothing matches.' : 'No assets yet. Drop images, documents or audio here, or press Upload.'}</div>`);
}

function meta(a) {
  if (a.kind === 'image') return [a.width && `${a.width}×${a.height}`, fmtSize(a.size)].filter(Boolean).join(' · ');
  if (a.kind === 'audio') return [fmtDur(a.duration), a.ext.toUpperCase(), fmtSize(a.size)].filter(Boolean).join(' · ');
  return [a.pages && `${a.pages} page${a.pages === 1 ? '' : 's'}`, a.words && `${a.words.toLocaleString()} word${a.words === 1 ? '' : 's'}`, fmtSize(a.size)].filter(Boolean).join(' · ');
}

// ---------- upload ----------
export function chooseFiles() { input().click(); }
const input = () => {
  let el = $('#libFileInput');
  if (!el) {
    el = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, id: 'libFileInput' });
    el.addEventListener('change', () => { uploadFiles(el.files); el.value = ''; });
    document.body.append(el);
  }
  el.accept = accept;
  return el;
};

export async function uploadFiles(files) {
  const list = [...files];
  const created = new Set();
  const filed = [];
  await Promise.all(list.map(async (file) => {
    const u = { name: file.name, kind: file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'document', progress: 0 };
    uploading.push(u);
    render();
    try {
      const context = characters.find((c) => c.id === view.character)?.name || '';
      const r = await uploadFile(file, { assign: true, context }, (p) => { u.progress = p; paintUploading(); });
      // Uploaded while a character is open: it belongs to them.
      if (view.character && view.character !== 'none' && !r.asset.characterIds.includes(view.character)) {
        await api(`/api/assets/${r.asset.id}`, { method: 'PATCH', body: JSON.stringify({ add: [view.character] }) });
      }
      for (const c of r.assignment?.created || []) created.add(c.name);
      const who = r.assignment?.summary?.[0]?.characters || [];
      if (who.length) filed.push(`${file.name} → ${who.join(', ')}`);
    } catch (e) {
      toast(e.message);
      if (e.login) showLogin();
    } finally {
      uploading = uploading.filter((x) => x !== u);
    }
  }));
  await load();
  render();
  if (created.size) toast(`New characters: ${[...created].join(', ')}`);
  else if (filed.length) toast(filed.length === 1 ? filed[0] : `${filed.length} files filed under characters`);
}
function paintUploading() {
  const cards = $('#libGrid').querySelectorAll('.lib-card.uploading');
  uploading.forEach((u, i) => {
    const bar = cards[i]?.querySelector('.tile-progress div');
    if (bar) bar.style.width = `${Math.round(u.progress * 100)}%`;
    const t = cards[i]?.querySelector('.lc-meta small');
    if (t) t.textContent = `Uploading ${Math.round(u.progress * 100)}%`;
  });
}

// ---------- one asset ----------
export async function openAsset(id) {
  let a;
  try {
    a = await api(`/api/assets/${id}`);
    if (!characters.length) await load();
  } catch (e) { return toast(e.message); }
  const card = $('#assetCard');
  let preview = '';
  if (a.kind === 'image') preview = `<img class="ap-image" src="${a.url}" alt="">`;
  else if (a.kind === 'audio') preview = `<div class="ap-audio"><span class="lc-file kind-audio big">♪<em>${esc(a.ext.toUpperCase())}</em></span><audio controls src="${a.url}"></audio></div>`;
  else preview = `<pre class="ap-text">Loading text…</pre>`;
  card.innerHTML = `<div class="modal-head"><input class="ap-name" value="${esc(a.name)}" maxlength="160" aria-label="File name"><button class="icon-btn" data-ap="close">✕</button></div>
    <div class="ap-body">
      <div class="ap-preview">${preview}</div>
      <div class="ap-side">
        <div class="ap-meta">${esc(meta(a))}${a.origin === 'generated' ? ' · generated' : ''}<br><small>Added ${new Date(a.createdAt).toLocaleString()}</small></div>
        <div class="pop-label">Characters</div>
        <div class="ap-chars">${characters.map((c) => `<label class="check"><input type="checkbox" value="${c.id}" ${a.characterIds.includes(c.id) ? 'checked' : ''}> <span>${esc(c.name)}</span></label>`).join('') || '<p class="hint">No characters yet.</p>'}
          <div class="ap-newchar"><input placeholder="New character name" maxlength="60" id="apNewChar"><button class="btn fit sm" data-ap="newchar">Add</button></div></div>
        <div class="ap-actions">
          <button class="btn btn-primary" data-ap="chat">Use in chat</button>
          <a class="btn" href="${a.original}" download>Download original</a>
          ${a.kind === 'image' ? `<a class="btn" href="${a.url}" target="_blank" rel="noopener">Open full size</a>` : ''}
          <button class="btn danger" data-ap="delete">Delete</button>
        </div>
      </div>
    </div>`;
  $('#assetModal').hidden = false;
  if (a.kind === 'document') {
    fetch(a.text).then((r) => r.text()).then((t) => { const pre = $('.ap-text', card); if (pre) pre.textContent = t.slice(0, 60000) + (t.length > 60000 ? '\n\n…' : ''); }).catch(() => {});
  }
  card.dataset.id = a.id;
  card._asset = a;
}

async function saveAssetChars(card) {
  const ids = [...card.querySelectorAll('.ap-chars input[type=checkbox]:checked')].map((x) => x.value);
  await api(`/api/assets/${card.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ characterIds: ids }) });
  await refreshIfOpen();
}
async function refreshIfOpen() {
  if (!$('#assets').hidden) { await load(); render(); } else await load();
}

// ---------- picker (attach library assets in chat) ----------
let pickCb = null;
const picked = new Set();
let pickKind = '';
export async function openPicker(cb) {
  pickCb = cb;
  picked.clear();
  pickKind = '';
  await load().catch((e) => toast(e.message));
  $('#pickChar').innerHTML = `<option value="">All characters</option><option value="none">Unassigned</option>${characters.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}`;
  $('#pickerModal').hidden = false;
  renderPicker();
}
async function renderPicker() {
  const q = new URLSearchParams();
  if (pickKind) q.set('kind', pickKind);
  if ($('#pickChar').value) q.set('character', $('#pickChar').value);
  const r = await api(`/api/assets?${q}`);
  $('#pickKinds').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.kind === pickKind));
  $('#pickGrid').innerHTML = r.assets.map((a) => `<button type="button" class="pick-item ${picked.has(a.id) ? 'on' : ''}" data-pick-id="${a.id}">${assetTile(a)}<span class="pick-check">✓</span></button>`).join('') || '<div class="empty">No assets here yet.</div>';
  $('#pickGrid')._assets = r.assets;
  $('#pickCount').textContent = picked.size ? `${picked.size} selected` : 'Nothing selected';
  $('[data-pick="use"]').disabled = !picked.size;
}

// ---------- events ----------
function wire() {
  const guard = (fn) => async (...x) => { try { await fn(...x); } catch (e) { toast(e.message); } };

  $('#libChars').addEventListener('click', (e) => {
    const li = e.target.closest('[data-char]');
    if (li) navigate(li.dataset.char || null);
  });
  $('#newCharacter').onclick = guard(async () => {
    const name = prompt('Character name');
    if (!name?.trim()) return;
    const c = await api('/api/characters', { method: 'POST', body: JSON.stringify({ name }) });
    navigate(c.id);
  });
  $('#libHead').addEventListener('change', guard(async (e) => {
    const f = e.target.closest('[data-cf]');
    if (!f) return;
    await api(`/api/characters/${view.character}`, { method: 'PATCH', body: JSON.stringify({ [f.dataset.cf]: f.value }) });
    await load(); render();
  }));
  $('#libHead').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-lh]');
    if (!b) return;
    if (b.dataset.lh === 'delete') {
      const c = characters.find((x) => x.id === view.character);
      if (!confirm(`Delete ${c?.name}? Their files stay in the library, unassigned.`)) return;
      await api(`/api/characters/${view.character}`, { method: 'DELETE' });
      navigate(null);
    }
    if (b.dataset.lh === 'chat') useInChat(assets);
  }));
  $('#libKinds').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    view.kind = b.dataset.kind;
    await load(); render();
  }));
  let searchTimer;
  $('#libSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(guard(async () => { view.q = $('#libSearch').value.trim(); await load(); render(); }), 250);
  });
  $('#libUpload').onclick = () => chooseFiles();
  $('#libAssign').onclick = guard(async () => {
    const b = $('#libAssign');
    b.disabled = true;
    b.textContent = 'Assigning…';
    try {
      const r = await api('/api/assets/assign', { method: 'POST', body: JSON.stringify({}) });
      const n = r.summary.filter((x) => x.changed).length;
      toast(n ? `Filed ${n} file${n > 1 ? 's' : ''} under characters${r.created.length ? `; new: ${r.created.map((c) => c.name).join(', ')}` : ''}` : 'No matches found. Assign them by dragging onto a character.');
      await load(); render();
    } finally { b.disabled = false; b.textContent = 'Auto-assign'; }
  });
  $('#libGrid').addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) openAsset(o.dataset.open);
  });

  // Drag a card onto a character to assign it (onto "Unassigned" to clear).
  $('#libGrid').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.lib-card[data-id]');
    if (!card) return;
    e.dataTransfer.setData('application/x-asset', card.dataset.id);
    e.dataTransfer.effectAllowed = 'link';
  });
  const chars = $('#libChars');
  chars.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-asset')) return;
    const li = e.target.closest('[data-drop]');
    if (li) { e.preventDefault(); chars.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on')); li.classList.add('drop-on'); }
  });
  chars.addEventListener('dragleave', (e) => e.target.closest('[data-drop]')?.classList.remove('drop-on'));
  chars.addEventListener('drop', guard(async (e) => {
    const id = e.dataTransfer.getData('application/x-asset');
    const li = e.target.closest('[data-drop]');
    chars.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
    if (!id || !li) return;
    e.preventDefault();
    e.stopPropagation();
    const body = li.dataset.drop === 'none' ? { characterIds: [] } : { add: [li.dataset.drop] };
    await api(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast(li.dataset.drop === 'none' ? 'Unassigned' : `Assigned to ${charName(li.dataset.drop)}`);
    await load(); render();
  }));

  // Asset modal
  $('#assetModal').addEventListener('click', guard(async (e) => {
    const card = $('#assetCard');
    if (e.target === $('#assetModal')) { $('#assetModal').hidden = true; return; }
    const b = e.target.closest('[data-ap]');
    if (!b) return;
    if (b.dataset.ap === 'close') $('#assetModal').hidden = true;
    if (b.dataset.ap === 'chat') { $('#assetModal').hidden = true; useInChat([card._asset]); }
    if (b.dataset.ap === 'delete') {
      if (!confirm(`Delete ${card._asset.name} from the library?`)) return;
      await api(`/api/assets/${card.dataset.id}`, { method: 'DELETE' });
      $('#assetModal').hidden = true;
      await refreshIfOpen();
    }
    if (b.dataset.ap === 'newchar') {
      const name = $('#apNewChar').value.trim();
      if (!name) return;
      const c = await api('/api/characters', { method: 'POST', body: JSON.stringify({ name }) });
      await api(`/api/assets/${card.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ add: [c.id] }) });
      await refreshIfOpen();
      openAsset(card.dataset.id);
    }
  }));
  $('#assetModal').addEventListener('change', guard(async (e) => {
    const card = $('#assetCard');
    if (e.target.matches('.ap-chars input[type=checkbox]')) await saveAssetChars(card);
    if (e.target.matches('.ap-name') && e.target.value.trim()) {
      await api(`/api/assets/${card.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ name: e.target.value }) });
      await refreshIfOpen();
    }
  }));
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $('#assetModal').hidden = true;
    $('#pickerModal').hidden = true;
  });

  // Picker
  $('#pickerModal').addEventListener('click', guard(async (e) => {
    if (e.target === $('#pickerModal')) { $('#pickerModal').hidden = true; return; }
    const kind = e.target.closest('#pickKinds [data-kind]');
    if (kind) { pickKind = kind.dataset.kind; return renderPicker(); }
    const item = e.target.closest('[data-pick-id]');
    if (item) {
      const id = item.dataset.pickId;
      picked.has(id) ? picked.delete(id) : picked.add(id);
      item.classList.toggle('on', picked.has(id));
      $('#pickCount').textContent = picked.size ? `${picked.size} selected` : 'Nothing selected';
      $('[data-pick="use"]').disabled = !picked.size;
      return;
    }
    const b = e.target.closest('[data-pick]');
    if (b?.dataset.pick === 'close') $('#pickerModal').hidden = true;
    if (b?.dataset.pick === 'use') {
      const chosen = [];
      for (const id of picked) chosen.push(($('#pickGrid')._assets || []).find((a) => a.id === id) || await api(`/api/assets/${id}`));
      $('#pickerModal').hidden = true;
      pickCb?.(chosen);
    }
  }));
  $('#pickChar').addEventListener('change', guard(renderPicker));
  void setCredits;
}
