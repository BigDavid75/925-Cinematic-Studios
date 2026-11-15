# Deploy to www.925cinema.com

The website runs on Render; your Mac stays at home as the image, video and sound engine, reachable only through a locked Cloudflare Tunnel.

```
visitor ──https──▶ www.925cinema.com (Render)
                          │  service token
                          ▼
                 comfy.925cinema.com (Cloudflare Access) ──tunnel──▶ ComfyUI on your Mac
```

## Where your DNS is now

You own `925cinema.com`, and its DNS is managed at **domains.com**, where it points at the "under construction" page:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | 208.91.197.27 | 5 min |
| A | `www` | 208.91.197.27 | 5 min |

Both records get replaced below. The domain stays registered at domains.com; only the DNS moves to Cloudflare.

## 1. Move DNS from domains.com to Cloudflare (needed for the locked tunnel)

The tunnel and its Access lock only work for a domain whose DNS is on Cloudflare.

1. Create a free account at cloudflare.com → **Add a domain** → `925cinema.com` → Free plan.
2. Cloudflare scans and copies your current records. **Delete both A records that point at 208.91.197.27.** Keep any MX or TXT records, so email on the domain keeps working.
3. Cloudflare shows you two nameservers (like `xxx.ns.cloudflare.com`). Write them down.
4. Sign in at domains.com → your domain list → `925cinema.com` → the **DNS & Nameservers** (or **Nameservers**) section → choose to use custom nameservers → replace the domains.com nameservers with the two Cloudflare ones → save. The exact menu names can differ slightly; domains.com support can do it for you if you ask them to "change the nameservers to Cloudflare's".
5. Back in Cloudflare, press **Check nameservers**. It usually becomes active within an hour (up to 24), and Cloudflare emails you when it does. From then on, all DNS changes for the site happen in Cloudflare, not domains.com.

## 2. Deploy the web app on Render

1. Sign in at render.com and connect GitHub, allowing access to **925-Cinematic-Studios**.
2. **New → Blueprint** → pick `925-Cinematic-Studios`. Render reads `render.yaml`: a Docker web service named `openartvision`, a 10GB disk at `/app/data`, the health check and the custom domain `www.925cinema.com`.
3. Fill in the secrets it asks for:
   - `ANTHROPIC_API_KEY`: your Claude API key.
   - `SITE_PASSWORD`: the password visitors type to get in. **Required.** The server will not start without it, or with `change-me`.
   - `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`: from step 4 below. You can deploy first and add them afterwards; until then the top bar shows **Engine offline** and nothing renders.
4. Apply. The first build takes a few minutes. It costs roughly $7 a month for the Starter instance plus about $2.50 for the disk.
5. Open the `*.onrender.com` address Render gives you and log in with your password to check it works.

## 3. Point www.925cinema.com at Render

In Render → the `openartvision` service → **Settings → Custom Domains**, `www.925cinema.com` is listed with the DNS target to use. In Cloudflare → **DNS → Records**, add:

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
cloudflared tunnel create cinema-comfy
```

```bash
cloudflared tunnel route dns cinema-comfy comfy.925cinema.com
```

Then lock it, **before** starting the tunnel:

1. Cloudflare dashboard → **Zero Trust → Access → Service auth → Create service token**. Copy the Client ID and Client Secret (the secret is shown once).
2. **Zero Trust → Access → Applications → Add → Self-hosted**: domain `comfy.925cinema.com`. Add a policy with action **Service Auth** that includes that service token. Add no other policies.
3. In Render → `openartvision` → **Environment**, set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. `COMFY_URL` is already `https://comfy.925cinema.com`.

Now start the tunnel:

```bash
cloudflared tunnel run --url http://localhost:8188 cinema-comfy
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
