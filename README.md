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
6. **Export.** MP4 (H.264), WebM (VP9), MOV (ProRes 422) or GIF, at source size, 720p or 1080p, then **Download**. Each clip can also be downloaded on its own. 720p and 1080p are a plain resize, not AI upscaling.

Generated clips are copied to the server's disk (`data/media`), so the timeline, stitching and export keep working when the Mac is offline. The film has no audio track: the video models used here produce silent clips.

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

- `image` → `txt2img_api.json`, a standard SDXL workflow. Change `ckpt_name` to a model you actually have.
- `video` → `txt2vid_api.json`, text-to-video with Wan 2.2 TI2V-5B (GGUF). Every Script to Film shot uses this. It was written from ComfyUI's Wan 2.2 5B template and has **not been run against a live ComfyUI**, so open it once on your Mac: set the three model file names to the files you downloaded, run it, and if a node is missing or renamed in your version, re-export your working workflow over this file and match the node ids in `config.json`. The workflow must end in a node that saves an **MP4**.
- `video_i2v` → `img2vid_api.json` (optional, yours to add). When present, the chat agent can animate an earlier image; without it, video requests fall back to text-to-video.

`"fps": 16` in `config.json` sets both the frame count (seconds × fps + 1) and the saved frame rate. 16 keeps clips light on a 16GB Mac; Wan 2.2 5B's native rate is 24.

## Deploy to www.925cinema.com

1. Put `925cinema.com` DNS on Cloudflare (free plan). Register the domain first if you have not.
2. Deploy this repo on Render, Railway or Fly.io as a Docker web service. Set the env vars from `.env.example`, and add a persistent disk mounted at `/app/data` (sessions, clips, timelines and exports live there). On Render, `render.yaml` at the repo root does this as a Blueprint: New → Blueprint → pick the repo, then fill in the secrets it asks for.
3. Add the custom domain `www.925cinema.com` in your host's dashboard, create the CNAME it gives you in Cloudflare, and redirect the bare domain `925cinema.com` to `www`.
4. On your Mac, expose ComfyUI with a Cloudflare Tunnel at `comfy.925cinema.com`, protected by a Cloudflare Access service token. Put the token in `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`.

The full step-by-step walkthrough is in the build guide.

## Files

| Path | What it does |
| --- | --- |
| `server.js` | Express server: login gate, SSE chat endpoint, job approve/dismiss, Script to Film API, media and downloads |
| `lib/script.js` | Script upload → text, local shot parser, Claude storyboard breakdown |
| `lib/projects.js` | Films: shots, render queue, timeline order, auto-stitch, exports |
| `lib/video.js` | ffmpeg: stitch clips (cut or crossfade), encode exports, mock clips |
| `lib/engine.js` | Runs jobs, keeps a local copy of every result, refunds failures |
| `lib/agent.js` | Claude agent loop: streams thinking/text, turns tool calls into approval cards, keeps thinking blocks intact |
| `lib/tools.js` | Tool schemas, system prompt, credit pricing, engine names |
| `lib/comfy.js` | Sends workflows to ComfyUI through the tunnel and collects the outputs |
| `lib/mock.js` | Simulated agent and engine for `npm run mock` |
| `lib/store.js` | JSON-file storage for sessions, jobs, films and credits (swap for Postgres when you add accounts) |
| `public/` | The studio UI (vanilla HTML/CSS/JS, no build step); `studio.js` is Script to Film |
| `workflows/` | ComfyUI workflows and the node mapping |
| `test/` | Parser tests (`npm test`) |
