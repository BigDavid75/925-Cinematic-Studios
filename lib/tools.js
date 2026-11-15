// Tool definitions the agent can call, plus pricing and engine names shown on the approval card.

export const ENGINES = {
  image: { fast: 'SDXL (Juggernaut XL)', quality: 'FLUX.1 dev (GGUF)' },
  video: { fast: 'Wan 2.1 1.3B', quality: 'Wan 2.2 TI2V-5B' }
};

export const SOUND_CREDITS_PER_SECOND = 3;
export const soundCreditsFor = (params) => (params.sound ? Math.round(Number(params.duration_seconds || 4) * SOUND_CREDITS_PER_SECOND) : 0);

export function creditsFor(kind, params, quality) {
  if (kind === 'image') return (params.resolution === '2K' ? 20 : 10) * (quality === 'quality' ? 1 : 0.5);
  const secs = Number(params.duration_seconds || 4);
  return Math.round(secs * (quality === 'quality' ? 25 : 12)) + soundCreditsFor(params);
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
      'Propose a short video clip (2-5 seconds) with optional generated sound. Text-to-video, or image-to-video when source_job_id points at an earlier image result or an image the user attached. The user must approve the card first. Clips are short; for longer pieces, plan several shots.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string', description: 'Describe the motion, camera move, subject and style.' },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
        duration_seconds: { type: 'integer', enum: [2, 3, 4, 5] },
        source_job_id: { type: 'string', description: 'Optional image to animate: the id of an earlier image job (job_...) or of an image in the asset library (ast_..., e.g. one the user uploaded or a character reference image). The clip starts from that image, so describe the motion, not the whole scene again.' },
        sound: { type: 'string', description: 'What the clip should sound like: ambience, sound effects, music mood, e.g. "rain on a tin roof, distant thunder". Generated to match the picture. It cannot produce intelligible speech or lyrics. Use an empty string for a silent clip.' }
      },
      required: ['title', 'prompt', 'aspect_ratio', 'duration_seconds']
    }
  }
];

TOOLS.push(
  {
    name: 'create_character',
    description: 'Add a character to the asset library (runs immediately, no approval). Use when the user introduces a character, or a document they uploaded describes characters that are not in the library yet. Optionally file assets under the new character at the same time.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Character name as written by the user or the document' },
        description: { type: 'string', description: 'Look, personality and role in one or two sentences; used to keep the character consistent in prompts' },
        asset_ids: { type: 'array', items: { type: 'string' }, description: 'Optional asset ids (ast_...) that belong to this character' }
      },
      required: ['name', 'description']
    }
  },
  {
    name: 'assign_assets',
    description: 'File assets from the asset library under a character, or remove them (runs immediately). Use to fix or complete the automatic assignment of uploads, or when the user says which character something belongs to.',
    input_schema: {
      type: 'object',
      properties: {
        asset_ids: { type: 'array', items: { type: 'string' }, description: 'Asset ids (ast_...)' },
        character: { type: 'string', description: 'Character name or id (chr_...)' },
        remove: { type: 'boolean', description: 'true to take the assets away from this character instead' }
      },
      required: ['asset_ids', 'character']
    }
  }
);

export const SYSTEM_PROMPT = `You are the creative agent inside 925 Cinematic Studios (www.925cinema.com), a studio for AI images and short video.

How you work:
- Turn the user's idea into concrete creative output. Think about what would be most useful first (a concept, a character lineup, key art, a storyboard frame, a short clip).
- To make an image or clip, call generate_image or generate_video with a strong, specific prompt. The user approves each card before it runs, so propose one or two generations at a time, not ten.
- After proposing a generation, write a short reply: say it is waiting for their go-ahead, then offer what you can do next (pilot script, storyboards, character sheets, more key art, animating a frame).
- Video clips are 2-5 seconds and low resolution; plan longer pieces as a sequence of shots.
- Clips can have generated sound (ambience, effects, music mood) matched to the picture: fill in "sound" on generate_video unless the user wants silence. It cannot make intelligible dialogue or singing.
- To animate an image, pass its id as source_job_id: an earlier image result (job_...) or an asset-library image (ast_...). Describe the motion and camera move.

Asset library and characters:
- Users can upload images, documents (PDF, Word, text, screenplays) and audio. Each upload is stored in the asset library with an id (ast_...) and automatically filed under the characters it belongs to; the message tells you what was filed where.
- Look at uploaded images and read uploaded documents. If an assignment is wrong or missing, fix it with assign_assets. If a document describes characters that aren't in the library, add them with create_character and file the document under them. Mention what you filed in a short line; don't list every id.
- When you write prompts for a character in the library, use their description and reference images so they look the same every time. A character's reference image can be the start image of a clip (source_job_id).
- You can't hear audio; treat an audio file as what its name and the user say it is (a voice sample, a theme).
- For anything longer than a clip or two (a script, a scene, a trailer), point the user to "Script to Film" in the sidebar: they upload or paste the script there, each shot renders as a clip, the clips line up on a timeline in script order, are stitched into one film, and can be exported as MP4, WebM, MOV or GIF. You can write or polish the script for them to paste in. Shot lists work best as "Shot 1: ...", "Shot 2: ..." lines.
- Messages that start with [Studio update] describe approvals and finished results. Use them; don't repeat them back verbatim.

Originality:
- When a user references an existing show, film, character or artist, take inspiration from genre, tone and themes only. Do not recreate or name copyrighted characters, logos or signature designs in prompts; build an original concept and say so briefly.
- No sexual content involving minors, no real private individuals, no sexual depictions of real people.

Style: warm, direct, concise. Use short paragraphs and simple bullet lists.`;
