// Characters and assigning assets to them.
// Rules first (names in the file name or the message, character lists in documents), then Claude when a key is set:
// it looks at the pictures, reads the documents, and decides who each asset belongs to.
import Anthropic from '@anthropic-ai/sdk';
import * as store from './store.js';
import { assetText, contentBlocks } from './assets.js';

const MOCK = process.env.MOCK === '1';
export const canUseAI = () => !MOCK && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const norm = (s) => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[_\-.+()[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createCharacter({ name, description = '' }) {
  name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw new Error('A character needs a name');
  const existing = findCharacter(name);
  if (existing) {
    if (description && !existing.description) { existing.description = String(description).slice(0, 600); store.putCharacter(existing); }
    return existing;
  }
  return store.putCharacter({ id: store.id('chr'), name, description: String(description || '').slice(0, 600), createdAt: Date.now() });
}

export function findCharacter(ref) {
  if (!ref) return null;
  const byId = store.getCharacter(ref);
  if (byId) return byId;
  const n = norm(ref);
  const all = store.listCharacters();
  return all.find((c) => norm(c.name) === n) || all.find((c) => norm(c.name).split(' ')[0] === n) || null;
}

export function assign(asset, characterIds, { replace = false } = {}) {
  const valid = characterIds.filter((id) => store.getCharacter(id));
  asset.characterIds = replace ? [...new Set(valid)] : [...new Set([...(asset.characterIds || []), ...valid])];
  store.putAsset(asset);
  return asset;
}
export function unassign(asset, characterIds) {
  asset.characterIds = (asset.characterIds || []).filter((id) => !characterIds.includes(id));
  store.putAsset(asset);
  return asset;
}

// Does a character's name (full, or a distinctive first name) appear in this text?
function mentions(text, c) {
  const t = ` ${norm(text)} `;
  const full = norm(c.name);
  if (full && new RegExp(`\\b${esc(full)}\\b`).test(t)) return true;
  const first = full.split(' ')[0];
  return first.length >= 3 && full.includes(' ') && new RegExp(`\\b${esc(first)}\\b`).test(t);
}

// Character lists in documents: "NAME: description", "Name - description", "NAME (34) description", or screenplay cues.
const NOT_NAMES = new Set(['int', 'ext', 'scene', 'act', 'fade in', 'fade out', 'cut to', 'characters', 'character', 'cast', 'logline', 'synopsis', 'title', 'setting', 'genre', 'tone', 'note', 'notes', 'episode', 'pilot', 'summary', 'theme', 'themes', 'location', 'locations', 'the end', 'continued', 'written by', 'draft', 'page', 'shot', 'description', 'age', 'role', 'premise', 'format', 'style', 'world']);
export function parseCharacterList(text) {
  const found = new Map();
  const add = (name, desc) => {
    name = name.replace(/\s+/g, ' ').trim().replace(/[:,.]$/, '');
    if (desc && !/[a-z]/.test(desc)) return; // "THE SHOW - SERIES BIBLE" is a title, not a character
    const key = norm(name);
    if (!key || NOT_NAMES.has(key) || key.length < 2 || key.split(' ').length > 3 || /\d/.test(key)) return;
    const pretty = name === name.toUpperCase() ? name.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()) : name;
    const prev = found.get(key);
    if (!prev || (!prev.description && desc)) found.set(key, { name: pretty, description: (desc || '').trim().slice(0, 400) });
  };
  const lines = String(text || '').split(/\r?\n/);
  const section = /^\s*(main\s+)?(characters?|cast( of characters)?|character (list|bible|breakdown)|dramatis personae)\s*:?\s*$/i;
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (section.test(line)) { inList = true; continue; }
    let m;
    if ((m = /^(?:[-*•]\s*|\d+[.)]\s*)?\**([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,2})\**\s*(?:\((?:[^)]{1,40})\))?\s*(?:[:–—]|\s-\s)\s*(.{12,})$/.exec(line))) add(m[1], m[2]);
    else if ((m = /^([A-Z][A-Z'.-]+(?:\s[A-Z][A-Z'.-]+){0,2})\s*\((\d{1,3}[^)]*)\)\s*,?\s*(.{8,})$/.exec(line))) add(m[1], `${m[2]}. ${m[3]}`);
    else if (inList && (m = /^(?:[-*•]\s*)?([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,2})\s*$/.exec(line))) add(m[1], '');
    else if (inList && !line) inList = false;
  }
  // Screenplay: names that speak at least twice (character cues on their own line).
  if (!found.size) {
    const cues = new Map();
    for (const raw of lines) {
      const m = /^\s{0,40}([A-Z][A-Z'.-]+(?:\s[A-Z][A-Z'.-]+){0,2})(?:\s*\((?:V\.O\.|O\.S\.|CONT'D|O\.C\.)\))?\s*$/.exec(raw);
      if (m && !/^(INT|EXT|FADE|CUT|DISSOLVE|SMASH|MATCH|THE END)/.test(m[1])) cues.set(m[1], (cues.get(m[1]) || 0) + 1);
    }
    for (const [n, c] of cues) if (c >= 2) add(n, '');
  }
  return [...found.values()].slice(0, 30);
}

// ---------- the rules ----------
function ruleAssign(assets, context) {
  const created = [];
  const docs = assets.filter((a) => a.kind === 'document');
  for (const d of docs) {
    const listed = parseCharacterList(assetText(d));
    // A document that lists characters (a bible, a cast list, a script) creates them and belongs to all of them.
    if (listed.length && (listed.length >= 2 || /charact|cast|bible/i.test(d.name))) {
      for (const c of listed) {
        const isNew = !findCharacter(c.name);
        const ch = createCharacter(c);
        if (isNew) created.push(ch);
        assign(d, [ch.id]);
      }
    }
  }
  const roster = store.listCharacters();
  const mentioned = roster.filter((c) => mentions(context, c));
  for (const a of assets) {
    const byName = roster.filter((c) => mentions(a.name, c));
    // Scripts, notes and treatments belong to the characters they mention.
    const inText = a.kind === 'document' ? roster.filter((c) => mentions(assetText(a).slice(0, 200000), c)) : [];
    if (byName.length || inText.length) assign(a, [...byName, ...inText].map((c) => c.id));
    // "this is Riley's voice" with one upload, or one character named in the message: everything uploaded with it is theirs.
    else if (mentioned.length === 1 && !a.characterIds?.length) assign(a, [mentioned[0].id]);
  }
  return created;
}

// ---------- Claude ----------
const SCHEMA = {
  type: 'object',
  properties: {
    new_characters: {
      type: 'array',
      description: 'Characters to add to the library: only characters a document describes or the user names. Not people in stock photos.',
      items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string', description: 'Look, personality, role; one or two sentences' } }, required: ['name', 'description'], additionalProperties: false }
    },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          asset_id: { type: 'string' },
          characters: { type: 'array', items: { type: 'string' }, description: 'Names of the characters this asset belongs to; empty if none fits' }
        },
        required: ['asset_id', 'characters'],
        additionalProperties: false
      }
    }
  },
  required: ['new_characters', 'assignments'],
  additionalProperties: false
};

const SYSTEM = `You file uploaded assets into a film studio's asset library, by character.

For each asset decide which characters it belongs to:
- Images: a character's reference art, model sheet, costume or face belongs to that character. Match by what you see against the character descriptions, the file name and the user's message. A group shot belongs to everyone in it.
- Documents: a character bible or cast list belongs to every character it describes; a script belongs to its speaking characters.
- Audio: a voice sample or theme belongs to the character the file name or the user's message points to.
Leave "characters" empty when nothing clearly fits; a wrong assignment is worse than none.

Add new characters only when a document describes them or the user names them. Keep names as written; don't invent names for people in photos. Existing characters must be referred to by their exact names.`;

let client;
async function aiAssign(assets, context) {
  client ||= new Anthropic();
  const roster = store.listCharacters();
  const content = [{
    type: 'text',
    text: `Characters already in the library:\n${roster.length ? roster.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ''}`).join('\n') : '(none yet)'}\n\nThe user's message with these uploads: ${context ? `"${context.slice(0, 2000)}"` : '(uploaded from the library page, no message)'}\n\nAssets:`
  }];
  for (const a of assets) {
    const blocks = contentBlocks(a);
    // Keep documents short here; assignment only needs who is in them.
    content.push(...blocks.map((b) => (b.type === 'text' && b.text.length > 24000 ? { ...b, text: `${b.text.slice(0, 24000)}\n[truncated]` } : b)));
  }
  const res = await client.messages.create({
    model: process.env.DEFAULT_MODEL || 'claude-sonnet-5-5',
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }]
  });
  if (res.stop_reason === 'refusal') throw new Error('declined');
  const data = JSON.parse(res.content.find((b) => b.type === 'text')?.text || '{}');
  const created = [];
  for (const c of data.new_characters || []) {
    const isNew = !findCharacter(c.name);
    const ch = createCharacter(c);
    if (isNew) created.push(ch);
  }
  for (const row of data.assignments || []) {
    const a = assets.find((x) => x.id === row.asset_id);
    if (!a) continue;
    const ids = (row.characters || []).map((n) => findCharacter(n)?.id).filter(Boolean);
    if (ids.length) assign(a, ids);
  }
  return created;
}

/**
 * File assets under the right characters. Returns { created, summary } where summary lines read
 * like 'riley_turnaround.png → Riley'.
 */
export async function autoAssign(assets, context = '') {
  assets = assets.filter(Boolean);
  if (!assets.length) return { created: [], summary: [], note: null };
  const before = new Map(assets.map((a) => [a.id, new Set(a.characterIds || [])]));
  let created = ruleAssign(assets, context);
  let note = null;
  if (canUseAI()) {
    try { created = [...created, ...(await aiAssign(assets, context))]; } catch (e) {
      console.error('AI assignment failed; kept the rule-based result', e);
      note = 'The AI matcher was unavailable, so assets were matched by name only.';
    }
  }
  const nameOf = (id) => store.getCharacter(id)?.name;
  const summary = assets.map((a) => {
    const now = (a.characterIds || []).map(nameOf).filter(Boolean);
    const added = (a.characterIds || []).filter((id) => !before.get(a.id).has(id));
    return { assetId: a.id, name: a.name, kind: a.kind, characters: now, changed: added.length > 0 };
  });
  return { created: [...new Map(created.map((c) => [c.id, c])).values()], summary, note };
}

export const summaryText = (r) => [
  ...(r.created.length ? [`New characters: ${r.created.map((c) => c.name).join(', ')}.`] : []),
  ...r.summary.map((s) => `${s.name} (${s.assetId}) → ${s.characters.length ? s.characters.join(', ') : 'not assigned to a character'}`),
  ...(r.note ? [r.note] : [])
].join('\n');

export function characterView(c) {
  const assets = store.listAssets().filter((a) => a.characterIds?.includes(c.id));
  const face = assets.find((a) => a.kind === 'image');
  return {
    id: c.id, name: c.name, description: c.description, createdAt: c.createdAt,
    counts: { image: assets.filter((a) => a.kind === 'image').length, document: assets.filter((a) => a.kind === 'document').length, audio: assets.filter((a) => a.kind === 'audio').length },
    avatar: face ? `/api/assets/${face.id}/file?v=thumb` : null
  };
}

// One line per character, for the agent and the storyboard writer.
export function rosterText() {
  const all = store.listCharacters();
  if (!all.length) return '';
  return all.map((c) => {
    const n = store.listAssets().filter((a) => a.characterIds?.includes(c.id));
    const refs = n.filter((a) => a.kind === 'image').map((a) => a.id).slice(0, 3);
    return `- ${c.name} (${c.id})${c.description ? `: ${c.description}` : ''}${n.length ? ` [${n.length} assets${refs.length ? `; reference images: ${refs.join(', ')}` : ''}]` : ''}`;
  }).join('\n');
}
