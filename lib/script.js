// Turns an uploaded script into an ordered list of shots.
// parseScript() is a deterministic local parser (no API needed). breakdownWithClaude() asks Claude to
// write a cinematic prompt per shot and falls back to the local parser if the call fails.
import Anthropic from '@anthropic-ai/sdk';

export const MAX_SHOTS = 60;
export const DURATIONS = [2, 3, 4, 5];
const clampDuration = (n) => Math.min(5, Math.max(2, Math.round(Number(n) || 4)));

const SLUG = /^\s*(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?)[\s.:-]+\S/i;
const MARKER = /^\s*(?:#{1,4}\s*)?(?:\*\*)?(shot|scene|clip|panel)\s*(\d+)[a-z]?\s*(?:\*\*)?\s*(?:[:.)\-–—]\s*|$)/i;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+\S/;
const TRANSITION = /^\s*(CUT TO|FADE IN|FADE OUT|FADE TO|DISSOLVE TO|SMASH CUT|MATCH CUT)[^a-z]*$/;
const CUE = /^\s*[A-Z][A-Z0-9 .'\-]{1,30}(\s*\((V\.O\.|O\.S\.|CONT'D|O\.C\.)\))?\s*$/;

// "(4s)", "[5 sec]", "- 3 seconds" anywhere in a shot's text sets its length.
function explicitDuration(text) {
  const m = /[\[(\-–—]\s*(\d(?:\.\d)?)\s*(?:s|sec|secs|second|seconds)\s*[\])]?/i.exec(text);
  return m ? clampDuration(m[1]) : null;
}
function estimateDuration(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return clampDuration(2 + words / 12);
}

const DURATION_NOTE = /\s*[\[(]\s*\d(?:\.\d)?\s*(?:s|sec|secs|second|seconds)\s*[\])]/gi;
const clean = (s) => s.replace(/\*\*|__|^#+\s*/g, '').replace(DURATION_NOTE, '').replace(/\s+/g, ' ').trim();

// Screenplay scene: keep what the camera sees (action lines); drop character cues, dialogue and parentheticals.
function actionOnly(lines) {
  const out = [];
  let inDialogue = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { inDialogue = false; continue; }
    if (TRANSITION.test(line)) continue;
    if (CUE.test(line) && !SLUG.test(line)) { inDialogue = true; continue; }
    if (inDialogue) continue;
    out.push(line);
  }
  return out.join(' ');
}

// Without AI, the sound model is steered by the shot's own description (it also watches the clip).
export function defaultSound(text) {
  const t = clean(String(text || '')).replace(/^(INT|EXT)[^.]*\.\s*/i, '');
  return t ? `Natural sound for: ${t}`.slice(0, 240) : '';
}

function makeShot(heading, body, visual) {
  const text = clean(body);
  const vis = clean(visual ?? body) || text;
  const prompt = [clean(heading), vis].filter(Boolean).join('. ').slice(0, 900);
  return {
    heading: clean(heading).slice(0, 90),
    text: text.slice(0, 1200),
    prompt,
    sound: defaultSound(vis || text),
    duration_seconds: explicitDuration(`${heading} ${body}`) ?? estimateDuration(vis)
  };
}

function splitBy(lines, isStart, build, dropPreamble = false) {
  const groups = [];
  let cur = null;
  for (const line of lines) {
    if (isStart(line)) { cur = { head: line, body: [] }; groups.push(cur); }
    else if (cur) cur.body.push(line);
    else if (line.trim() && !dropPreamble) { cur = { head: '', body: [line] }; groups.push(cur); }
  }
  return groups.map(build).filter((s) => s && (s.prompt || s.text));
}

export function parseScript(script) {
  const lines = String(script || '').replace(/\r\n?/g, '\n').split('\n');
  const count = (re) => lines.filter((l) => re.test(l)).length;
  let shots;

  if (count(MARKER) >= 2) {
    // "Shot 1: ...", "SCENE 2 - ...", "## Shot 3"
    shots = splitBy(lines, (l) => MARKER.test(l), (g) => {
      const rest = g.head.replace(MARKER, '').trim();
      const body = [rest, ...g.body].join(' ');
      const m = MARKER.exec(g.head);
      const label = m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}` : '';
      const s = makeShot('', body);
      s.heading = label || s.heading;
      return s;
    });
  } else if (count(SLUG) >= 1) {
    // Screenplay: one shot per scene heading (INT./EXT.)
    shots = splitBy(lines, (l) => SLUG.test(l), (g) => makeShot(g.head, g.body.join(' '), actionOnly(g.body)), true); // title page / FADE IN before scene 1 is not a shot
  } else if (count(NUMBERED) >= 2) {
    shots = splitBy(lines, (l) => NUMBERED.test(l), (g) => makeShot('', [g.head.replace(/^\s*\d{1,3}[.)]\s+/, ''), ...g.body].join(' ')));
  } else {
    // Prose: one shot per paragraph; a single paragraph is split into sentences.
    let paras = String(script || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paras.length === 1) paras = paras[0].match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter((s) => s.length > 2) || paras;
    shots = paras.map((p) => makeShot('', p));
  }

  return shots.slice(0, MAX_SHOTS).map((s, i) => ({ ...s, heading: s.heading || `Shot ${i + 1}` }));
}

// ---------- Claude breakdown ----------
const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '2-5 word title for the film' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'Short label, e.g. "Rooftop at dawn"' },
          script_text: { type: 'string', description: 'The part of the script this shot covers, quoted or closely paraphrased' },
          prompt: { type: 'string', description: 'Text-to-video prompt: subject, action, camera move, setting, lighting, style' },
          sound: { type: 'string', description: 'What the shot sounds like: ambience, effects, music mood. No dialogue (the sound model cannot speak).' },
          duration_seconds: { type: 'integer', enum: DURATIONS }
        },
        required: ['heading', 'script_text', 'prompt', 'sound', 'duration_seconds'],
        additionalProperties: false
      }
    }
  },
  required: ['title', 'shots'],
  additionalProperties: false
};

const BREAKDOWN_SYSTEM = `You are a storyboard artist for OpenArtVision, a studio that renders short AI video clips and stitches them into one film.

Break the user's script into shots, in the exact order the script tells the story. Each shot becomes one generated clip of 2-5 seconds, so:
- One clear visual moment per shot: a subject, one action, one camera move. Split long scenes into several shots.
- Write each prompt so it stands alone. The video model sees only that one prompt, so restate who is on screen (look, clothing), where, the time of day and the visual style every time. Keep recurring characters and the style worded the same way across shots so the film looks consistent.
- The video model can't render readable text or lip-synced dialogue. Show what is seen while a line is spoken, not the line.
- Cover the whole script from start to finish; don't skip the ending. Use at most ${MAX_SHOTS} shots.
- If the script references an existing show, film or character, keep the genre and tone but describe original characters and designs.
- For each shot also write "sound": the ambience, effects and music mood a sound model should add to that clip (e.g. "wind over the cliff, gulls, low cello drone"). Keep music mood consistent across the film. No dialogue or lyrics.`;

let client;
export async function breakdownWithClaude(script, { style = '', model } = {}) {
  client ||= new Anthropic();
  const res = await client.messages.create({
    model: model || process.env.DEFAULT_MODEL || 'claude-sonnet-5-5',
    max_tokens: 16000,
    system: BREAKDOWN_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: `${style ? `Visual style: ${style}\n(The studio appends this style line to every prompt automatically, so don't repeat it; keep everything else consistent with it.)\n\n` : ''}Script:\n\n${script}`
    }]
  });
  if (res.stop_reason === 'refusal') throw new Error('The agent declined to break down this script.');
  if (res.stop_reason === 'max_tokens') throw new Error('The script is too long to break down in one pass. Split it into parts.');
  const text = res.content.find((b) => b.type === 'text')?.text;
  const data = JSON.parse(text);
  const shots = (data.shots || []).slice(0, MAX_SHOTS).map((s, i) => ({
    heading: String(s.heading || `Shot ${i + 1}`).slice(0, 90),
    text: String(s.script_text || '').slice(0, 1200),
    prompt: String(s.prompt || '').slice(0, 900),
    sound: String(s.sound || '').slice(0, 300),
    duration_seconds: clampDuration(s.duration_seconds)
  }));
  if (!shots.length) throw new Error('No shots came back');
  return { title: String(data.title || '').slice(0, 60), shots };
}

// ---------- uploaded files -> plain text ----------
export async function extractScriptText(name, buffer) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'docx') {
    const mammoth = (await import('mammoth')).default;
    return (await mammoth.extractRawText({ buffer })).value.trim();
  }
  if (ext === 'pdf') {
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    return (await pdfParse(buffer)).text.trim();
  }
  if (ext === 'srt' || ext === 'vtt') {
    // Subtitles: drop cue numbers and timestamps, keep the lines.
    return buffer.toString('utf8').split(/\r?\n/).filter((l) => !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^WEBVTT/.test(l)).join('\n').trim();
  }
  if (ext === 'doc') throw new Error('Old .doc files are not supported. Save it as .docx, .pdf or .txt.');
  const text = buffer.toString('utf8');
  if (/\u0000/.test(text.slice(0, 2000))) throw new Error('That file is not a text script. Use .txt, .md, .fountain, .docx or .pdf.');
  return text.trim();
}
