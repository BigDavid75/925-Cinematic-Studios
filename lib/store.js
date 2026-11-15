// Tiny JSON-file store for sessions, jobs and credits.
// Good for a single-owner studio. Swap for Postgres (e.g. Supabase) when you add user accounts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const FILE = path.join(DATA_DIR, 'store.json');

const state = {
  credits: Number(process.env.START_CREDITS || 1000),
  sessions: {}, // id -> session
  jobs: {},     // id -> job
  projects: {}, // id -> script-to-film project (shots, timeline, exports)
  assets: {},   // id -> uploaded image / document / audio
  characters: {} // id -> character the assets belong to
};

try {
  if (fs.existsSync(FILE)) Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  state.assets ||= {};
  state.characters ||= {};
} catch (e) {
  console.warn('Could not read store, starting fresh:', e.message);
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  }, 300);
}

export const id = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function createSession() {
  const s = {
    id: crypto.randomUUID(),
    title: 'Untitled session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [], // Claude API transcript (includes thinking blocks + signatures)
    display: [],  // what the UI renders on reload
    notes: []     // events (approvals, results) to tell the agent on its next turn
  };
  state.sessions[s.id] = s;
  save();
  return s;
}

export const getSession = (sid) => state.sessions[sid];

export function listSessions() {
  return Object.values(state.sessions)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
}

export function deleteSession(sid) {
  delete state.sessions[sid];
  save();
}

export const getJob = (jid) => state.jobs[jid];
export function putJob(job) {
  state.jobs[job.id] = job;
  save();
  return job;
}

export const listJobs = () => Object.values(state.jobs);

// ---------- projects (script -> shots -> timeline -> film) ----------
export const getProject = (pid) => state.projects[pid];
export function putProject(p) {
  p.updatedAt = Date.now();
  state.projects[p.id] = p;
  save();
  return p;
}
export function listProjects() {
  return Object.values(state.projects).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function deleteProject(pid) {
  delete state.projects[pid];
  save();
}

// ---------- asset library ----------
export const getAsset = (aid) => state.assets[aid];
export function putAsset(a) {
  state.assets[a.id] = a;
  save();
  return a;
}
export const listAssets = () => Object.values(state.assets).sort((a, b) => b.createdAt - a.createdAt);
export function deleteAsset(aid) {
  delete state.assets[aid];
  save();
}

export const getCharacter = (cid) => state.characters[cid];
export function putCharacter(c) {
  state.characters[c.id] = c;
  save();
  return c;
}
export const listCharacters = () => Object.values(state.characters).sort((a, b) => a.name.localeCompare(b.name));
export function deleteCharacter(cid) {
  delete state.characters[cid];
  for (const a of Object.values(state.assets)) if (a.characterIds?.includes(cid)) a.characterIds = a.characterIds.filter((x) => x !== cid);
  save();
}

export const getCredits = () => state.credits;
export function spendCredits(n) {
  if (state.credits < n) return false;
  state.credits -= n;
  save();
  return true;
}
