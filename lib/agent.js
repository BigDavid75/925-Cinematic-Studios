// The agent loop: streams Claude's thinking and text to the browser, turns tool calls into approval cards.
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, SYSTEM_PROMPT, ENGINES, creditsFor, soundCreditsFor } from './tools.js';
import { id, putJob, save } from './store.js';
import { soundAvailable } from './engine.js';

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

// Build the user content for this turn: studio notes + attachments + text.
// `uploads` are the attachments saved as upload records, so the agent can animate them by id.
export function buildUserContent(session, text, attachments = [], uploads = []) {
  const content = [];
  if (session.notes.length) {
    content.push({ type: 'text', text: `[Studio update]\n${session.notes.join('\n')}` });
    session.notes = [];
  }
  for (const a of attachments) {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(a.dataUrl || '');
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[3] } });
  }
  if (uploads.length) content.push({ type: 'text', text: uploads.map((u, i) => `[Attached image id: ${u.id}${uploads.length > 1 ? ` (image ${i + 1})` : ''}]`).join('\n') });
  content.push({ type: 'text', text: text || '(see attached image)' });
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
          emit('tool_drafting', { tool: b.name, toolUseId: b.id });
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
