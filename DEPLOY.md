# Deploying Beam to a Google Cloud VM

This walks through hosting Beam on a single Google Compute Engine VM, served at
**https://beam.kroszborg.co** with HTTPS.

> **Shortcut:** on any Docker host, `BEAM_DOMAIN=beam.example.com docker compose up -d`
> runs the server, the app and automatic HTTPS (Caddy) in two containers — no
> nginx, Redis or certbot steps. The rest of this guide is the manual setup.

## Architecture on the box

```
                         beam.kroszborg.co (DNS A → VM external IP)
                                   │  :443 / :80
                              ┌────▼─────┐
   browser  ───────────────▶ │  nginx   │
                              └────┬─────┘
            static client (dist)  │   /ws /ice /health  (reverse proxy)
            served from disk      ▼
                          ┌───────────────┐     ┌─────────┐
                          │ beam-server   │····▶│  redis  │
                          │ (node, :8787) │     │(optional)│
                          └───────────────┘     └─────────┘
```

- **Client** = a static SPA (Vite build). nginx serves it from disk.
- **Signaling server** = Node process on `127.0.0.1:8787`, proxied by nginx at
  `/ws`, `/ice`, `/health`. Keeps rooms in memory; when two peers can't
  connect directly it also relays their (end-to-end encrypted) stream over `/ws`.
- **Redis** = only needed to run several server instances; skip it otherwise.

---

## 1. Recommended VM specs

| Setting        | Value                                              |
| -------------- | -------------------------------------------------- |
| Machine type   | **e2-small** (2 vCPU, 2 GB) — comfortable. e2-micro works for light traffic |
| OS             | **Ubuntu 24.04 LTS** (or 22.04)                    |
| Boot disk      | 20–30 GB standard persistent disk                  |
| Region         | Closest to your users (e.g. `us-central1`, `asia-south1`) |
| Firewall       | Allow **HTTP** and **HTTPS** traffic               |

The server is lightweight: file bytes normally go peer-to-peer and only touch
the VM when the encrypted relay fallback is used (it stays end-to-end
encrypted), so a small VM is plenty. Most cost comes from the VM being always-on.

### Create it (gcloud)

```bash
gcloud compute instances create beam \
  --machine-type=e2-small \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB \
  --tags=http-server,https-server \
  --zone=us-central1-a

# Firewall (only needed if the default rules don't already allow 80/443)
gcloud compute firewall-rules create allow-web \
  --allow=tcp:80,tcp:443 --target-tags=http-server,https-server
```

Note the VM's **external IP** from `gcloud compute instances list`.

---

## 2. DNS

At your domain registrar / DNS for `kroszborg.co`, add an **A record**:

```
Type: A    Name: beam    Value: <VM external IP>    TTL: 300
```

Wait for it to resolve: `dig +short beam.kroszborg.co` should return the IP.

---

## 3. Server setup (SSH into the VM)

```bash
gcloud compute ssh beam --zone=us-central1-a
```

Install Node 22+, pnpm, Redis, nginx, certbot:

> **Use Node 22.** The repo pins pnpm 10.33.2 via `packageManager`, so
> corepack installs that exact version. Node 22 LTS is what's tested.

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs redis-server nginx git
node -v                                   # must be v22.x
sudo corepack enable                      # provides pnpm
sudo apt install -y certbot python3-certbot-nginx

sudo systemctl enable --now redis-server
```

If you already installed Node 20, switch to 22 first:

```bash
sudo apt remove -y nodejs
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v                                   # v22.x
```

---

## 4. Get the code & build

```bash
sudo mkdir -p /opt/beam && sudo chown $USER /opt/beam
git clone https://github.com/Kroszborg/beam /opt/beam
cd /opt/beam
pnpm install --frozen-lockfile

# pnpm 11 blocks unapproved build scripts (esbuild) and errors when running a
# script. The repo allow-lists esbuild via package.json > pnpm.onlyBuiltDependencies,
# so a normal install builds it. If you still hit ERR_PNPM_IGNORED_BUILDS, either
# run `pnpm approve-builds` (select esbuild) once, or build vite directly:
#   cd packages/client && ./node_modules/.bin/vite build && cd ../..

# Build the client pointing at the public origin (same host).
# The client turns https:// into wss:// and calls /ws + /ice automatically.
VITE_SIGNALING_URL=https://beam.kroszborg.co pnpm --filter @beam/client build

# Publish the static build
sudo mkdir -p /var/www/beam
sudo cp -r packages/client/dist/* /var/www/beam/
```

Create the server env file `/opt/beam/.env`:

```ini
PORT=8787
HOST=127.0.0.1
# Only for multi-instance setups (then also set the same SESSION_SECRET on each):
# REDIS_URL=redis://localhost:6379
ROOM_TTL_SECONDS=3600
CORS_ORIGINS=https://beam.kroszborg.co
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
# Optional TURN (see §8) — leave blank for STUN-only:
TURN_URL=
TURN_USERNAME=
TURN_CREDENTIAL=
# Encrypted relay fallback through this server (costs bandwidth when used):
RELAY_ENABLED=true
MAX_RECEIVERS=8
NODE_ENV=production
```

---

## 5. Run the signaling server as a service

Create `/etc/systemd/system/beam-server.service`:

```ini
[Unit]
Description=Beam signaling server
After=network.target redis-server.service

[Service]
WorkingDirectory=/opt/beam
EnvironmentFile=/opt/beam/.env
# tsx is a server dependency, so this path is stable across installs.
ExecStart=/opt/beam/packages/server/node_modules/.bin/tsx /opt/beam/packages/server/src/index.ts
Restart=always
RestartSec=3
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

> No `chown` needed: pnpm installs world-readable files, so `www-data` can run
> the server while you keep ownership of `/opt/beam` for `git pull`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now beam-server
sudo systemctl status beam-server          # should be "active (running)"
curl -s localhost:8787/health              # {"status":"ok",...}
```

---

## 6. nginx (static client + proxy + WebSocket upgrade)

Create `/etc/nginx/sites-available/beam`:

```nginx
server {
    listen 80;
    server_name beam.kroszborg.co;

    root /var/www/beam;
    index index.html;

    # SPA: fall back to index.html for client-side routes (/send, /r/:id, ...)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # The service worker (streaming downloads, share target) must never be
    # cached, or clients keep running an old version after a deploy.
    location = /sw.js {
        add_header Cache-Control "no-cache";
    }

    # Hashed build assets can be cached forever.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # WebSocket signaling — requires the upgrade headers
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        # Relayed transfers can run for hours.
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }

    location ~ ^/(ice|health)$ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/beam /etc/nginx/sites-enabled/beam
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Beam should now load over **http://beam.kroszborg.co**.

---

## 7. HTTPS (Let's Encrypt)

```bash
sudo certbot --nginx -d beam.kroszborg.co --redirect -m you@example.com --agree-tos -n
```

certbot edits the nginx config to add `:443` + auto-redirect and sets up renewal.
Visit **https://beam.kroszborg.co** — done. WebRTC + clipboard require HTTPS, so
this step is mandatory for production.

### Security headers (recommended)

nginx drops server-level `add_header`s in any `location` that sets its own (the
cache headers above do), so put the security headers in a snippet and include
it at server level *and* in each of those locations. Create
`/etc/nginx/snippets/beam-security-headers.conf`:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

# Same policy the bundled server sends when it serves the app (STATIC_DIR):
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; frame-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
```

Then add `include snippets/beam-security-headers.conf;` inside the `:443`
`server { ... }` block and inside the `location /`, `location = /sw.js` and
`location /assets/` blocks (add `add_header Cache-Control "no-cache";` to
`location /` too, so a deploy is picked up immediately), and
`sudo nginx -t && sudo systemctl reload nginx`.

---

## 8. Optional: TURN for strict networks

STUN-only fails for some symmetric-NAT / CGNAT pairs. Beam's built-in relay
covers them out of the box (through this server's bandwidth). To keep that
traffic off your server, run a TURN server (e.g. `coturn`) or use a hosted one (Metered, Twilio), then fill
`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` in `/opt/beam/.env` and
`sudo systemctl restart beam-server`. No client change needed — it reads `/ice`.

---

## 9. Redeploying after changes

```bash
cd /opt/beam && git pull
pnpm install --frozen-lockfile
VITE_SIGNALING_URL=https://beam.kroszborg.co pnpm --filter @beam/client build
sudo cp -r packages/client/dist/* /var/www/beam/
sudo systemctl restart beam-server
```

> **Small boxes (≤1 GB RAM, no swap):** build the client on your own machine
> instead — `VITE_SIGNALING_URL=https://beam.kroszborg.co pnpm --filter
> @beam/client build`, then `scp` the contents of `packages/client/dist` to
> `/var/www/beam/` — and only run `pnpm install` + the restart on the box.
>
> If `pnpm install` stops with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
> (node_modules came from a different pnpm version), rerun it with `CI=true`.

> **Upgrading a box set up before protocol v2:** also add the `/sw.js` and
> `/assets/` blocks and the `/ws` timeouts from §6 to the nginx config, then
> `sudo nginx -t && sudo systemctl reload nginx`. Redis is now optional — an
> existing `REDIS_URL` keeps working. v1 and v2 clients can't talk to each
> other; a stale tab shows a "different version of Beam" message until it's
> reloaded.

## 10. Quick checks

```bash
curl -s https://beam.kroszborg.co/health      # {"status":"ok"}
curl -s https://beam.kroszborg.co/ice          # STUN/TURN JSON
sudo journalctl -u beam-server -f              # live server logs
```

Open `/send` in one browser and the generated link in another to confirm a real
end-to-end transfer over the deployed stack.

---

# Alternative: AWS Lightsail

Lightsail is a good low-cost home for Beam. The **$5/mo plan (512 MB RAM,
2 vCPU)** is enough to *run* it — the server is featherweight because file
bytes normally go peer-to-peer. Only the encrypted relay fallback sends them
through the VM (counted against the included transfer; set
`RELAY_ENABLED=false` to turn it off).
The only catch is that **512 MB is tight for the Vite build**, so add swap.

Advantages over a plain VM: a **free static IP** (no more IP-changes-on-restart)
and ~1 TB included transfer.

## L1. Console setup

- **Networking → Static IP → Create & attach** to the instance. Use this IP for DNS.
- **Networking → IPv4 Firewall → add** HTTP (80) and HTTPS (443). SSH (22) is default.

## L2. Connect (from Windows PowerShell)

Lightsail hands you a `.pem` key. Lock it down first (OpenSSH refuses world-
readable keys), then connect:

```powershell
$key = "C:\path\to\LightsailDefaultKey-ap-south-1.pem"
icacls $key /inheritance:r /grant:r "$($env:USERNAME):(R)"
ssh -i $key ubuntu@<STATIC_IP>
```

## L3. Swap (important on 512 MB)

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## L4. Install, build, configure

The user is `ubuntu` (not a custom user). Everything else mirrors the GCP steps:

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs redis-server nginx git certbot python3-certbot-nginx
sudo corepack enable
sudo systemctl enable --now redis-server

sudo mkdir -p /opt/beam && sudo chown $USER /opt/beam
git clone https://github.com/Kroszborg/beam /opt/beam
cd /opt/beam && pnpm install --frozen-lockfile
cd packages/client
VITE_SIGNALING_URL=https://beam.kroszborg.co ./node_modules/.bin/vite build
cd /opt/beam && sudo mkdir -p /var/www/beam && sudo cp -r packages/client/dist/* /var/www/beam/
```

Then create `/opt/beam/.env` (§4 — use `TURN_API_URL` for Metered), the systemd
service (§5), and the nginx config (§6) exactly as in the GCP guide.

## L5. DNS + HTTPS

Point the `beam` A record at the **Lightsail static IP**, confirm with
`getent hosts beam.kroszborg.co`, then:

```bash
sudo certbot --nginx -d beam.kroszborg.co --redirect --agree-tos -m you@example.com -n
curl -s https://beam.kroszborg.co/health && echo
curl -s https://beam.kroszborg.co/ice && echo
```

Redeploys and quick checks are identical to §9 / §10 above.
