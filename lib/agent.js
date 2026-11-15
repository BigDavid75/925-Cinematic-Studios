// The agent loop: streams Claude's thinking and text to the browser, turns generation tool calls into approval cards,
// and runs asset-library tools (characters, assignments) right away.
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, SYSTEM_PROMPT, ENGINES, creditsFor, soundCreditsFor } from './tools.js';
import { id, putJob, save, getAsset, getCharacter } from './store.js';
import { soundAvailable } from './engine.js';
import { contentBlocks } from './assets.js';
import { createCharacter, findCharacter, assign, unassign, rosterText, summaryText } from './characters.js';

const GENERATION_TOOLS = new Set(['generate_image', 'generate_video']);

// Library tools run right away (no approval card) and report what changed.
function runLibraryTool(block) {
  const input = block.input || {};
  if (block.name === 'create_character') {
    const existed = !!findCharacter(input.name);
    const c = createCharacter({ name: input.name, description: input.description });
    const assigned = (input.asset_ids || []).map(getAsset).filter(Boolean);
    for (const a of assigned) assign(a, [c.id]);
    return {
      result: `${existed ? 'Character already existed' : 'Created character'} ${c.name} (${c.id})${assigned.length ? `; assigned ${assigned.map((a) => a.name).join(', ')}` : ''}.`,
      note: `${existed ? 'Updated' : 'New character'}: ${c.name}${assigned.length ? ` · ${assigned.map((a) => a.name).join(', ')}` : ''}`
    };
  }
  if (block.name === 'assign_assets') {
    const c = findCharacter(input.character);
    if (!c) return { result: `No character named "${input.character}". Create it first with create_character.`, error: true };
    const assets = (input.asset_ids || []).map(getAsset).filter(Boolean);
    if (!assets.length) return { result: 'None of those asset ids exist.', error: true };
    for (const a of assets) (input.remove ? unassign : assign)(a, [c.id]);
    return {
      result: `${input.remove ? 'Removed' : 'Assigned'} ${assets.map((a) => `${a.name} (${a.id})`).join(', ')} ${input.remove ? 'from' : 'to'} ${c.name}.`,
      note: `${assets.map((a) => a.name).join(', ')} ${input.remove ? '✕' : '→'} ${c.name}`
    };
  }
  return { result: `Unknown tool ${block.name}`, error: true };
}

const MODELS = {
  'sonnet-5.5': 'claude-sonnet-5-5',
  'opus-5.5': 'claude-opus-5-5',
  'haiku-5.5': 'claude-haiku-5-5'
};
export const resolveModel = (key) => MODELS[key] || process.env.DEFAULT_MODEL || 'claude-sonnet-5-5';

let client;
const anthropic = () => (client ||= new Anthropic());

export function makeJob(session, toolUse, opts) {
  const kind = toolUse.name === 'generate_video' ? 'video' : 'image';
  const params = { ...toolUse.input };
  if (kind === 'video') params.sound = soundAvailable() ? String(params.sound || '').trim().slice(0, 300) : '';
  const quality = opts.quality || 'quality';
  return putJob({
    id: id('job'),
    sessionId: session.id,
    toolUseId: toolUse.id,
    kind,
    params,
    quality,
    engine: ENGINES[kind][quality],
    credits: creditsFor(kind, params, quality),
    soundCredits: kind === 'video' ? soundCreditsFor(params) : 0,
    status: 'awaiting_approval',
    progress: 0,
    outputs: [],
    createdAt: Date.now()
  });
}

function toolResultText(job, auto) {
  return auto
    ? `Job ${job.id} started automatically (Auto mode). The result will appear in the chat when done.`
    : `Card for job ${job.id} is now shown to the user and is waiting for their approval. Do not call the tool again for this request. Briefly tell the user it is waiting for their go-ahead and offer next steps.`;
}

// Build the user content for this turn: studio notes, the character roster, uploaded assets, then the text.
// `assets` are asset-library records (images, documents, audio); `assignment` is what autoAssign did with them.
export function buildUserContent(session, text, assets = [], assignment = null) {
  const content = [];
  if (session.notes.length) {
    content.push({ type: 'text', text: `[Studio update]\n${session.notes.join('\n')}` });
    session.notes = [];
  }
  const roster = rosterText();
  if (roster && (assets.length || session.messages.length === 0 || /charact|cast|asset|library|voice/i.test(text))) {
    content.push({ type: 'text', text: `[Characters in the asset library]\n${roster}` });
  }
  for (const a of assets) content.push(...contentBlocks(a));
  if (assets.length) {
    content.push({ type: 'text', text: `[Uploaded to the asset library with this message]\n${assignment ? summaryText(assignment) : assets.map((a) => `${a.name} (${a.id})`).join('\n')}\nCheck these assignments against what you see; fix any with assign_assets or create_character.` });
  }
  content.push({ type: 'text', text: text || '(see attached files)' });
  return content;
}

/**
 * Runs one user turn. `emit(event, data)` streams to the browser.
 * Returns the assistant display entry so the session can be re-rendered later.
 */
export async function runTurn({ session, userContent, opts, emit, signal, onJobAuto }) {
  const model = resolveModel(opts.model);
  const display = { role: 'assistant', parts: [] };
  session.display.push(display);
  session.messages.push({ role: 'user', content: userContent });

  for (let step = 0; step < 6; step++) {
    const stream = anthropic().messages.stream(
      {
        model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        thinking: { type: 'adaptive', display: 'summarized' },
        messages: session.messages
      },
      { signal }
    );

    let current = null; // display part currently streaming
    let thinkStart = 0;
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'thinking') {
          thinkStart = Date.now();
          current = { type: 'thinking', text: '' };
          display.parts.push(current);
          emit('thinking_start', {});
        } else if (b.type === 'text') {
          current = { type: 'text', text: '' };
          display.parts.push(current);
          emit('text_start', {});
        } else if (b.type === 'tool_use') {
          current = { type: 'drafting', tool: b.name };
          if (GENERATION_TOOLS.has(b.name)) emit('tool_drafting', { tool: b.name, toolUseId: b.id });
        }
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'thinking_delta' && current?.type === 'thinking') {
          current.text += ev.delta.thinking;
          emit('thinking', { text: ev.delta.thinking });
        } else if (ev.delta.type === 'text_delta' && current?.type === 'text') {
          current.text += ev.delta.text;
          emit('text', { text: ev.delta.text });
        }
      } else if (ev.type === 'content_block_stop') {
        if (current?.type === 'thinking') {
          current.seconds = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
          emit('thinking_end', { seconds: current.seconds });
        }
        current = null;
      }
    }

    const final = await stream.finalMessage();
    // Keep every block (thinking, redacted_thinking, signatures) unchanged for the next request.
    session.messages.push({ role: 'assistant', content: final.content });

    if (final.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of final.content.filter((b) => b.type === 'tool_use')) {
      if (!GENERATION_TOOLS.has(block.name)) {
        const r = runLibraryTool(block);
        if (r.note) {
          const part = { type: 'library', lines: [r.note] };
          display.parts.push(part);
          emit('library', part);
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: r.result, ...(r.error ? { is_error: true } : {}) });
        continue;
      }
      const job = makeJob(session, block, opts);
      const auto = opts.approval === 'auto';
      display.parts.push({ type: 'job', jobId: job.id });
      emit('tool_card', job);
      if (auto) onJobAuto?.(job);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: toolResultText(job, auto) });
    }
    session.messages.push({ role: 'user', content: results });
  }

  session.updatedAt = Date.now();
  save();
  return display;
}

export async function makeTitle(text) {
  try {
    const r = await anthropic().messages.create({
      model: process.env.TITLE_MODEL || 'claude-haiku-5-5',
      max_tokens: 30,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: `Write a 2-5 word title for this creative request. Reply with the title only, no quotes.\n\n${text}` }]
    });
    return r.content.find((b) => b.type === 'text')?.text.trim().replace(/^"|"$/g, '').slice(0, 60) || null;
  } catch {
    return null;
  }
}
