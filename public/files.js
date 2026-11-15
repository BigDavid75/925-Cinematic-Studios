// Shared upload + display helpers for chat attachments and the asset library.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
export const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

export const KIND_ICON = { image: '▣', document: '▤', audio: '♪' };
const EXT_LABEL = (a) => (a.ext || a.name?.split('.').pop() || '').toUpperCase().slice(0, 5);

// Upload one file to the asset library. The body is the raw file; onProgress gets 0..1.
export function uploadFile(file, { sessionId, assign = false, context = '' } = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ name: file.name || 'file', type: file.type || '' });
    if (sessionId) q.set('sessionId', sessionId);
    if (assign) q.set('assign', '1');
    if (context) q.set('context', context.slice(0, 500));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/assets?${q}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 401) return reject(Object.assign(new Error('Please log in'), { login: true }));
      if (xhr.status >= 400) return reject(new Error(data.error || `Upload failed (${xhr.status})`));
      resolve(data);
    };
    xhr.onerror = () => reject(new Error(`Could not upload ${file.name}`));
    xhr.send(file);
  });
}

// Small tile for an asset: image thumbnail, or an icon card for documents and audio.
export function assetTile(a, { removable = false, index = 0, pending = null } = {}) {
  const status = pending
    ? `<div class="tile-progress"><div style="width:${Math.round((pending.progress || 0) * 100)}%"></div></div>`
    : '';
  const err = a.error ? `<div class="tile-err" title="${esc(a.error)}">!</div>` : '';
  const rm = removable ? `<button type="button" class="tile-rm" data-rm="${index}" aria-label="Remove">✕</button>` : '';
  if (a.kind === 'image' && (a.thumb || a.preview)) {
    return `<div class="tile tile-image${pending ? ' busy' : ''}" title="${esc(a.name)}"><img src="${esc(a.thumb || a.preview)}" alt="">${status}${err}${rm}</div>`;
  }
  const meta = a.kind === 'audio' ? fmtDur(a.duration) : a.pages ? `${a.pages} page${a.pages === 1 ? '' : 's'}` : a.words ? `${a.words} word${a.words === 1 ? '' : 's'}` : '';
  return `<div class="tile tile-file kind-${a.kind || 'document'}${pending ? ' busy' : ''}" title="${esc(a.name)}">
    <span class="tile-icon">${KIND_ICON[a.kind] || '▤'}<em>${esc(EXT_LABEL(a))}</em></span>
    <span class="tile-text"><b>${esc(a.name)}</b><small>${esc(meta || (pending ? 'Uploading…' : ''))}</small></span>${status}${err}${rm}</div>`;
}

// Larger card used inside chat messages (playable audio, clickable docs and images).
export function messageAsset(a) {
  const open = `data-asset="${esc(a.id)}"`;
  if (a.kind === 'image') return `<button type="button" class="m-asset m-image" ${open}><img src="/api/assets/${esc(a.id)}/file?v=thumb" alt="${esc(a.name)}"></button>`;
  if (a.kind === 'audio') return `<div class="m-asset m-audio"><button type="button" class="m-name" ${open}>♪ ${esc(a.name)}</button><audio controls preload="none" src="/api/assets/${esc(a.id)}/file"></audio></div>`;
  return `<button type="button" class="m-asset m-doc" ${open}><span class="tile-icon">▤<em>${esc(EXT_LABEL(a))}</em></span><span>${esc(a.name)}</span></button>`;
}
