# OpenArtVision

A web-based AI creative studio for **www.925cinema.com**, in the style of Runway. Generation runs on your own ComfyUI engine (your Mac, through a tunnel). Two ways to work:

- **Script to Film:** upload a script, get one clip per shot on a timeline in script order, stitched into one film you can export.
- **Agent chat:** describe an idea; a Claude-powered agent proposes image or video generations as approval cards.

## Script to Film

1. **Script.** Paste a script or upload a file (`.txt`, `.md`, `.fountain`, `.docx`, `.pdf`, `.srt`).
2. **Break into shots.** The script is split into shots in the order it is written:
   - With *Write prompts with AI* on (needs `ANTHROPIC_API_KEY`), Claude storyboards the script and writes a video prompt for each shot.
   - Otherwise it is split locally, with no API call: screenplay scene headings (`INT.` / `EXT.`), `Shot 1:` / `Scene 2 -` markers, numbered lists, or one shot per paragraph. Dialogue stays out of the prompt. Add `(3s)` to a shot to set its length (2 to 5 seconds).
3. **Shots.** Edit any prompt or length, add or remove shots, then **Generate all** or generate one shot at a time. Shots render one after another so the Mac only ever works on one clip. Credits are refunded for a failed or cancelled shot.
4. **Timeline.** Every shot has a slot, in script order. A clip drops into its own slot when it finishes, whatever order the renders finish in. Click a clip to jump the film to it.
5. **Film.** Finished clips are stitched automatically (ffmpeg) into one preview, re-stitched whenever a clip is added, replaced or removed. Choose **Cut** or **Crossfade** between clips.
6. **Export.** MP4 (H.264 + AAC), WebM (VP9 + Opus), MOV (ProRes 422 + PCM) or GIF, at source size, 720p or 1080p, then **Download**. Each clip can also be downloaded on its own. 720p and 1080p are a plain resize, not AI upscaling.

Generated clips are copied to the server's disk (`data/media`), so the timeline, stitching and export keep working when the Mac is offline. Clips get generated sound (see **Sound** below), and the film and its exports keep it.

## How the chat box works

1. **Home composer:** Reference and Sketch inputs, an image attach button, a model picker (Sonnet 5.5 / Opus 5.5 / Haiku 5.5), an Ask/Auto and Quality/Fast mode menu, and send.
2. **On send:** the page switches to a session view and your message appears on the right. The address bar gets `?s=<session id>`.
3. **Thinking:** a live "Thinking ›" stream (Claude's summarized reasoning). It collapses to "Thought for Ns" and you can tap it to reopen.
4. **Writing prompt…:** a skeleton card appears while the agent writes its tool call.
5. **Generate Image / Generate Video card:** shows the prompt (tap › to read it all), aspect ratio, resolution or duration, model and credits. You can Approve it, Edit it (✎) or Dismiss it (✕).
6. **The agent keeps talking** while the card waits ("The lineup is waiting for your go-ahead…").
7. **Approve:** credits are deducted, the job runs on ComfyUI, a progress bar shows, and the image or video appears in the card. If the job fails, your credits are refunded.
8. **The session gets an auto-title** and shows up in **Recents**. The send button turns into **Stop** while the agent is working.
9. **On your next message,** the agent is told what you approved, dismissed or received, so it can build on it.

## Run it locally

```bash
npm install
npm run mock        # full UI, simulated agent, placeholder clips; Script to Film works end to end, no keys needed
npm test            # script parser tests
# or, for the real thing:
cp .env.example .env   # add ANTHROPIC_API_KEY, SITE_PASSWORD, COMFY_URL
npm start              # http://localhost:3000
```

Stitching and export need **ffmpeg** on the machine that runs the web server (`brew install ffmpeg`; the Dockerfile installs it).

## Connect your image and video engine

`workflows/config.json` maps each kind of generation to a ComfyUI workflow exported with **Export (API)**:

| Key | Workflow | Used for |
| --- | --- | --- |
| `image` | `txt2img_api.json` | Images in chat (SDXL). Change `ckpt_name` to a model you have. |
| `video` | `txt2vid_api.json` | Every Script to Film shot, and chat clips with no start image (Wan 2.2 TI2V-5B, GGUF). |
| `video_i2v` | `img2vid_api.json` | Chat clips that animate an image: an earlier image result, or a picture the user attaches. Same Wan 2.2 5B model, with a Load Image node feeding `start_image`. |
| `audio` | `video2audio_api.json` | The sound pass: MMAudio watches each finished clip and writes matching sound. |

**None of these workflows has been run against a live ComfyUI.** They were written from ComfyUI's templates and the node packs' documented inputs. Before going live, open each one on your Mac (drag the JSON into ComfyUI), set the model file names to the files you downloaded, and run it once. If a node is missing or renamed in your version, re-export your working workflow over the file with **Export (API)** and match the node ids in `config.json`.

`"fps": 16` sets both the frame count (seconds × fps + 1) and the saved frame rate. 16 keeps clips light on a 16GB Mac; Wan 2.2 5B's native rate is 24.

### Sound

Wan 2.2 makes silent video, so sound is a second pass on each clip:

1. The clip renders (Wan 2.2).
2. If the clip file already has sound, it is kept and the pass is skipped. So if you later switch the `video` workflow to a model that makes audio itself (LTX-2, which needs 32GB+), nothing else has to change.
3. Otherwise the clip goes to `video2audio_api.json`: **MMAudio** generates sound synced to the picture, steered by the shot's sound line ("rain on a tin roof, distant thunder").
4. The server puts that sound on the clip with ffmpeg. The stitched film keeps every clip's sound (silence for silent clips, crossfaded when you choose Crossfade), and MP4, WebM and MOV exports carry it. GIF has no sound.

Each shot has a ♪ sound line. Claude's breakdown writes one per shot; the local parser uses the shot's description. A project-wide **Sound** switch turns it off. Sound costs 3 credits per second and is refunded if the pass fails; the clip is then kept silent. MMAudio cannot make intelligible speech or singing, so dialogue in a script becomes ambience, not voices.

Install on the Mac (ComfyUI Manager → Custom Nodes Manager, or `git clone` into `custom_nodes`):

- **ComfyUI-MMAudio** by kijai.
- Models from Hugging Face `Kijai/MMAudio_safetensors` into `ComfyUI/models/mmaudio/`: `mmaudio_large_44k_v2_fp16.safetensors`, `mmaudio_vae_44k_fp16.safetensors`, `mmaudio_synchformer_fp16.safetensors`, `apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors` (about 4GB in all).
- The workflow loads the clip with ComfyUI's built-in **Load Video** and **Get Video Components** nodes, so ComfyUI must be recent (2025 or later).

The sound model runs after the video model has unloaded (`force_offload` is on), so they don't need memory at the same time. Delete the `audio` block in `config.json` to turn sound off entirely.

### Image-to-video in chat

Attach a picture in the chat (or make an image first) and ask the agent to animate it. Each attached image is saved and given an id the agent can pass as `source_job_id`. The card shows the start image, the motion prompt and the sound, and you can edit them before approving. If `img2vid_api.json` is removed, those requests fall back to text-to-video and the card says so.

## Deploy to www.925cinema.com

Step-by-step instructions, including the DNS changes from your current records, are in **[DEPLOY.md](DEPLOY.md)**.

Two safety rules are built in:

- **`SITE_PASSWORD` is required.** In production (`NODE_ENV=production`, which the Dockerfile sets) the server refuses to start without it, or with the example value `change-me`. Otherwise anyone who finds the site could spend your Claude API credits and use your Mac.
- **The tunnel must be locked.** ComfyUI has no login. If `COMFY_URL` is a public address, the server will not send it any work unless `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` are set **and** a request without them is refused (it checks this). The top bar shows **Engine online**, **Engine offline** or **Engine unlocked**.

## Files

| Path | What it does |
| --- | --- |
| `server.js` | Express server: login gate, SSE chat endpoint, job approve/dismiss, Script to Film API, media and downloads |
| `lib/script.js` | Script upload → text, local shot parser, Claude storyboard breakdown |
| `lib/projects.js` | Films: shots, render queue, timeline order, auto-stitch, exports |
| `lib/video.js` | ffmpeg: stitch clips with their sound (cut or crossfade), encode exports, add sound to clips, mock clips |
| `lib/engine.js` | Runs jobs, chat image uploads, the sound pass, keeps a local copy of every result, refunds failures |
| `lib/agent.js` | Claude agent loop: streams thinking/text, turns tool calls into approval cards, keeps thinking blocks intact |
| `lib/tools.js` | Tool schemas, system prompt, credit pricing, engine names |
| `lib/comfy.js` | Sends workflows to ComfyUI through the tunnel, runs the sound pass, checks the tunnel is locked |
| `lib/mock.js` | Simulated agent and engine for `npm run mock` |
| `lib/store.js` | JSON-file storage for sessions, jobs, films and credits (swap for Postgres when you add accounts) |
| `public/` | The studio UI (vanilla HTML/CSS/JS, no build step); `studio.js` is Script to Film |
| `workflows/` | ComfyUI workflows and the node mapping |
| `test/` | Parser tests (`npm test`) |
