// MOCK=1: a simulated agent and image engine, so the whole UI can be tested without API keys or a GPU.
import { makeJob } from './agent.js';
import { save, listJobs } from './store.js';

const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
  });

async function streamText(text, emit, part, event, signal, speed = 18) {
  for (const word of text.split(/(\s+)/)) {
    await sleep(speed, signal);
    part.text += word;
    emit(event, { text: word });
  }
}

export async function runMockTurn(args) {
  const userText = args.userContent.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  if (/\b(animate|video|clip|motion|move)\b/i.test(userText)) return runMockVideoTurn(args, userText);
  return runMockImageTurn(args, userText);
}

// "Animate this": image-to-video from the attached image or the latest image in this chat, with sound.
async function runMockVideoTurn({ session, userContent, opts, emit, signal, onJobAuto }, userText) {
  const display = { role: 'assistant', parts: [] };
  session.display.push(display);
  session.messages.push({ role: 'user', content: userContent });
  const uploaded = /\[Attached image id: (upl_\w+)/.exec(userText)?.[1];
  const latest = listJobs().filter((j) => j.sessionId === session.id && j.kind === 'image' && j.status === 'done').sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
  const source = uploaded || latest;

  const thinking = { type: 'thinking', text: '' };
  display.parts.push(thinking);
  emit('thinking_start', {});
  const t0 = Date.now();
  await streamText(source
    ? `They want motion. I'll animate ${uploaded ? 'the image they attached' : 'the latest image from this chat'} (${source}) with a slow push-in, and add ambient sound that matches the scene.`
    : `They want a clip but there's no image to start from, so I'll write a text-to-video prompt with matching ambient sound.`, emit, thinking, 'thinking', signal, 25);
  thinking.seconds = Math.max(1, Math.round((Date.now() - t0) / 1000));
  emit('thinking_end', { seconds: thinking.seconds });

  emit('tool_drafting', { tool: 'generate_video' });
  await sleep(1200, signal);
  const job = makeJob(session, {
    id: 'toolu_mock_video',
    name: 'generate_video',
    input: {
      title: source ? 'Animated frame' : 'Short clip',
      prompt: source ? 'Slow cinematic push-in, subtle parallax, hair and fabric moving gently in the wind, soft light flicker.' : `Cinematic shot: ${userText.replace(/\[[^\]]*\]/g, '').slice(0, 120)}. Slow dolly, soft natural light.`,
      aspect_ratio: '16:9',
      duration_seconds: 4,
      ...(source ? { source_job_id: source } : {}),
      sound: 'gentle wind, distant birds, soft ambient pad'
    }
  }, opts);
  display.parts.push({ type: 'job', jobId: job.id });
  emit('tool_card', job);
  if (opts.approval === 'auto') onJobAuto?.(job);

  const text = { type: 'text', text: '' };
  display.parts.push(text);
  emit('text_start', {});
  await streamText(`The clip is ${opts.approval === 'auto' ? 'rendering now' : 'waiting for your go-ahead'}. ${source ? 'It starts from your image' : 'It is text-to-video'} and gets matching ambient sound. For a longer piece, open **Script to Film** and paste a script.`, emit, text, 'text', signal);
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: text.text }] });
  session.updatedAt = Date.now();
  save();
  return display;
}

async function runMockImageTurn({ session, userContent, opts, emit, signal, onJobAuto }, userText) {
  const display = { role: 'assistant', parts: [] };
  session.display.push(display);
  session.messages.push({ role: 'user', content: userContent });

  const thinking = { type: 'thinking', text: '' };
  display.parts.push(thinking);
  emit('thinking_start', {});
  const t0 = Date.now();
  await streamText(
    `The user wants: "${userText.slice(0, 120)}". If this references an existing show or character, I'll take inspiration from its tone and themes only and build an original concept, keeping names and designs original. The most useful first step is a character lineup image so they can see the cast. I'll write a detailed prompt for a 16:9 model sheet, propose it for approval, and then offer a pilot script, storyboards and key art as next steps.`,
    emit, thinking, 'thinking', signal, 25
  );
  thinking.seconds = Math.max(1, Math.round((Date.now() - t0) / 1000));
  emit('thinking_end', { seconds: thinking.seconds });

  emit('tool_drafting', { tool: 'generate_image' });
  await sleep(1800, signal);
  const job = makeJob(session, {
    id: 'toolu_mock',
    name: 'generate_image',
    input: {
      title: 'Character lineup',
      prompt: `Character lineup model sheet for an original adult animated series inspired by: ${userText.slice(0, 80)}. Five original characters standing side by side, full body, front view, bold clean line art, flat cel shading, expressive faces, neutral studio background, name-free.`,
      aspect_ratio: '16:9',
      resolution: '2K'
    }
  }, opts);
  display.parts.push({ type: 'job', jobId: job.id });
  emit('tool_card', job);
  if (opts.approval === 'auto') onJobAuto?.(job);

  const text = { type: 'text', text: '' };
  display.parts.push(text);
  emit('text_start', {});
  await streamText(
    `The cast lineup is ${opts.approval === 'auto' ? 'generating now' : 'waiting for your go-ahead'}.\n\nI kept the concept original, so no existing characters or names are recreated. Here's what I can make next:\n\n- A full pilot script\n- Storyboards\n- Character sheets\n- Key art\n- A short animated clip from any frame\n\nOnce you approve the lineup, I can write the pilot script next.`,
    emit, text, 'text', signal
  );

  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: text.text }] });
  session.updatedAt = Date.now();
  save();
  return display;
}

export function mockTitle(text) {
  const words = text.replace(/[^\w\s']/g, '').split(/\s+/).filter((w) => w.length > 3).slice(0, 4);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'New Creation';
}

export async function runMockJob(job, onProgress) {
  for (let i = 1; i <= 8; i++) {
    await sleep(500);
    onProgress(i / 9);
  }
  return [{ filename: `${job.id}.svg`, media: 'image', mock: true }];
}

export function mockMedia(job) {
  const [w, h] = { '16:9': [1600, 900], '9:16': [900, 1600], '1:1': [1200, 1200], '4:3': [1200, 900], '3:4': [900, 1200], '21:9': [2100, 900] }[job.params.aspect_ratio] || [1600, 900];
  const hue = [...job.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const figures = Array.from({ length: 5 }, (_, i) => {
    const x = (w / 6) * (i + 1);
    const s = h / 900;
    return `<g transform="translate(${x} ${h * 0.62}) scale(${s})" fill="hsl(${(hue + i * 50) % 360} 60% 60%)"><circle cy="-260" r="60"/><rect x="-55" y="-190" width="110" height="230" rx="40"/><rect x="-45" y="40" width="35" height="170" rx="16"/><rect x="10" y="40" width="35" height="170" rx="16"/></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 40% 18%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 45% 10%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${figures}<text x="${w / 2}" y="${h - 40}" fill="#ffffff88" font-family="sans-serif" font-size="${h / 30}" text-anchor="middle">MOCK PREVIEW · connect ComfyUI for real images</text></svg>`;
}

export { save };
