# Deploy to www.925cinema.com

The website runs on Render; your Mac stays at home as the image, video and sound engine, reachable only through a locked Cloudflare Tunnel.

```
visitor ──https──▶ www.925cinema.com (Render)
                          │  service token
                          ▼
                 comfy.925cinema.com (Cloudflare Access) ──tunnel──▶ ComfyUI on your Mac
```

## Where your DNS is now

`925cinema.com` currently points at your registrar's "under construction" page:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | 208.91.197.27 | 5 min |
| A | `www` | 208.91.197.27 | 5 min |

Both records get replaced below. The 5-minute TTL means changes show up quickly.

## 1. Move DNS to Cloudflare (needed for the locked tunnel)

The tunnel and its Access lock only work for a domain whose DNS is on Cloudflare.

1. Create a free account at cloudflare.com → **Add a domain** → `925cinema.com` → Free plan.
2. Cloudflare copies your current records. **Delete both A records that point at 208.91.197.27.** Keep any MX or TXT records (email).
3. Cloudflare shows two nameservers. At the registrar where the records above live, replace the domain's nameservers with those two. This can take from minutes to a few hours; Cloudflare emails you when the domain is active.

## 2. Deploy the web app on Render

1. Sign in at render.com and connect GitHub, allowing access to **925-Cinematic-Studios**.
2. **New → Blueprint** → pick `925-Cinematic-Studios`. Render reads `render.yaml`: a Docker web service named `925cinema`, a 10GB disk at `/app/data`, the health check and the custom domain `www.925cinema.com`.
3. Fill in the secrets it asks for:
   - `ANTHROPIC_API_KEY`: your Claude API key.
   - `SITE_PASSWORD`: the password visitors type to get in. **Required.** The server will not start without it, or with `change-me`.
   - `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`: from step 4 below. You can deploy first and add them afterwards; until then the top bar shows **Engine offline** and nothing renders.
4. Apply. The first build takes a few minutes. It costs roughly $7 a month for the Starter instance plus about $2.50 for the disk.
5. Open the `*.onrender.com` address Render gives you and log in with your password to check it works.

## 3. Point www.925cinema.com at Render

In Render → the `925cinema` service → **Settings → Custom Domains**, `www.925cinema.com` is listed with the DNS target to use. In Cloudflare → **DNS → Records**, add:

| Type | Name | Target | Proxy status |
| --- | --- | --- | --- |
| CNAME | `www` | the `….onrender.com` host Render shows | DNS only (grey cloud) |
| A | `@` | the IP Render shows for the root domain (currently 216.24.57.1) | DNS only (grey cloud) |

Render redirects `925cinema.com` to `www.925cinema.com`. Back in Render, press **Verify**; it issues the HTTPS certificate on its own, usually within minutes. Keep the grey cloud so Render can issue and renew it.

## 4. Connect and lock your Mac

ComfyUI has no login of its own. **Never expose it on the web without the Access lock below.** The site enforces this: it sends no work to a public ComfyUI address unless the service token is set *and* a request without the token is refused.

On the Mac, with ComfyUI running on port 8188:

```bash
brew install cloudflared
```

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create oav-comfy
```

```bash
cloudflared tunnel route dns oav-comfy comfy.925cinema.com
```

Then lock it, **before** starting the tunnel:

1. Cloudflare dashboard → **Zero Trust → Access → Service auth → Create service token**. Copy the Client ID and Client Secret (the secret is shown once).
2. **Zero Trust → Access → Applications → Add → Self-hosted**: domain `comfy.925cinema.com`. Add a policy with action **Service Auth** that includes that service token. Add no other policies.
3. In Render → `925cinema` → **Environment**, set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. `COMFY_URL` is already `https://comfy.925cinema.com`.

Now start the tunnel:

```bash
cloudflared tunnel run --url http://localhost:8188 oav-comfy
```

Check the lock from any computer. Without the token this must **not** return ComfyUI's JSON:

```bash
curl -i https://comfy.925cinema.com/system_stats
```

You should get a 403 or a redirect to a Cloudflare login page. On the site, click the engine pill in the top bar: it should say **Engine online**. **Engine unlocked** means the Access policy is missing, and generation stays blocked until you fix it.

While serving, keep the Mac plugged in and awake:

```bash
caffeinate -dims
```

## 5. Before the first real render

1. Install the node packs and models listed in the README (ComfyUI-GGUF, the Wan 2.2 5B GGUF files, ComfyUI-MMAudio and its models).
2. Open each workflow in `workflows/` in ComfyUI on the Mac, set your model file names, and run it once by hand. None of them has been run against a live ComfyUI yet. If one fails, re-export your working version with **Export (API)** over the file, match the node ids in `workflows/config.json`, and push.
3. On the site: make a two-shot film in **Script to Film**, render it, and export an MP4 with sound. In chat, attach a picture, ask to animate it, and approve the card.
