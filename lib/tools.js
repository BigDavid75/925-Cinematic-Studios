// Tool definitions the agent can call, plus pricing and engine names shown on the approval card.

export const ENGINES = {
  image: { fast: 'SDXL (Juggernaut XL)', quality: 'FLUX.1 dev (GGUF)' },
  video: { fast: 'Wan 2.1 1.3B', quality: 'Wan 2.2 TI2V-5B' }
};

export function creditsFor(kind, params, quality) {
  if (kind === 'image') return (params.resolution === '2K' ? 20 : 10) * (quality === 'quality' ? 1 : 0.5);
  const secs = Number(params.duration_seconds || 4);
  return Math.round(secs * (quality === 'quality' ? 25 : 12));
}

export const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Propose an image generation. The user sees a card with your prompt and settings and must press Approve before anything runs (unless they chose Auto mode). Use for key art, character sheets, storyboards frames, mood boards, product shots.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label for the card, e.g. "Character lineup"' },
        prompt: { type: 'string', description: 'Detailed visual prompt: subject, style, composition, lighting, palette.' },
        negative_prompt: { type: 'string', description: 'Things to avoid.' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'] },
        resolution: { type: 'string', enum: ['1K', '2K'] }
      },
      required: ['title', 'prompt', 'aspect_ratio', 'resolution']
    }
  },
  {
    name: 'generate_video',
    description:
      'Propose a short video clip (2-5 seconds). Text-to-video, or image-to-video when source_job_id points at an earlier image result. The user must approve the card first. Clips are short; for longer pieces, plan several shots.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string', description: 'Describe the motion, camera move, subject and style.' },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
        duration_seconds: { type: 'integer', enum: [2, 3, 4, 5] },
        source_job_id: { type: 'string', description: 'Optional id of an earlier image job to animate.' }
      },
      required: ['title', 'prompt', 'aspect_ratio', 'duration_seconds']
    }
  }
];

export const SYSTEM_PROMPT = `You are the creative agent inside OpenArtVision (www.openartvision.com), a studio for AI images and short video.

How you work:
- Turn the user's idea into concrete creative output. Think about what would be most useful first (a concept, a character lineup, key art, a storyboard frame, a short clip).
- To make an image or clip, call generate_image or generate_video with a strong, specific prompt. The user approves each card before it runs, so propose one or two generations at a time, not ten.
- After proposing a generation, write a short reply: say it is waiting for their go-ahead, then offer what you can do next (pilot script, storyboards, character sheets, more key art, animating a frame).
- Video clips are 2-5 seconds and low resolution; plan longer pieces as a sequence of shots.
- For anything longer than a clip or two (a script, a scene, a trailer), point the user to "Script to Film" in the sidebar: they upload or paste the script there, each shot renders as a clip, the clips line up on a timeline in script order, are stitched into one film, and can be exported as MP4, WebM, MOV or GIF. You can write or polish the script for them to paste in. Shot lists work best as "Shot 1: ...", "Shot 2: ..." lines.
- Messages that start with [Studio update] describe approvals and finished results. Use them; don't repeat them back verbatim.

Originality:
- When a user references an existing show, film, character or artist, take inspiration from genre, tone and themes only. Do not recreate or name copyrighted characters, logos or signature designs in prompts; build an original concept and say so briefly.
- No sexual content involving minors, no real private individuals, no sexual depictions of real people.

Style: warm, direct, concise. Use short paragraphs and simple bullet lists.`;
