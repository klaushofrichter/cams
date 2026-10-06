# cams on the Pi: the demo kit

The cam-proxy Raspberry Pi and the camera, nothing else: cams runs on the Pi
next to cam-proxy, and a browser on the same LAN opens `http://<pi>:8080`
(at home `http://192.168.1.220:8080`), or the Pi's own browser
`http://127.0.0.1:8080`. Sign-in is a **login token** instead of Google, so
no internet and no public address are needed. Design and rulings:
[2026-10-04-pi-deployment-design](superpowers/specs/2026-10-04-pi-deployment-design.md),
and for the one `.env` and the camera's address from cam-proxy
[2026-10-04-camera-address-from-proxy-design](superpowers/specs/2026-10-04-camera-address-from-proxy-design.md).

The image is the same as the cluster's (`ghcr.io/klaushofrichter/cams`,
amd64 and arm64). The cluster keeps Google sign-in and Secure cookies; the Pi
sets these instead:

| Variable | On the Pi | |
|---|---|---|
| `CAMS_LOGIN_TOKEN` (or `CAMS_LOGIN_TOKEN_FILE`) | required | 24+ characters; shorter refuses to start. Rotating it signs its sessions out |
| `CAMS_TOKEN_USER` | `local` (default) | the identity of a token session (preferences are kept per identity) |
| `COOKIE_SECRET` | required | signs the session cookie |
| `COOKIE_SECURE` | `false` | the session cookie works over plain http; logged as `cookie_secure_off` at startup |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS` | unset | without them only the token form shows |
| `CAMERAS_FILE`, `PREFS_FILE`, `PROXY_STATE_FILE`, `CACHE_DIR`, `CACHE_MAX_BYTES` | see the compose file | |

**One file for the Pi:** cams' secrets live in the Pi's one settings file,
cam-proxy's `/srv/cam-proxy/config/.env`, which also holds the camera's
address (`CAMERA_HOST`) and the Pi's (`PI_ADDRESS`) for cam-proxy. `$CAMS/.env`
is a symlink to it (`../config/.env`) that compose reads only for the `${…}`
in the compose file: the container gets `CAMS_LOGIN_TOKEN`, `COOKIE_SECRET`
and `CAMS_TOKEN_USER`, never cam-proxy's secrets (no `env_file`). cams
doesn't keep the camera's address at all: its `cameras.json` says
`"host": "from-proxy"` (which needs `protocol` `https` and a
`tlsServername`: the camera's certificate is checked, so a wrong address from
the proxy can't receive the camera login), and cams uses the address
cam-proxy reports. Until
cam-proxy has answered once after cams starts, what cams asks the camera
directly (status, snapshot, settings) says "Waiting for the proxy to report
the camera's address." The last address stays while cam-proxy is away.

## Setup

On the Pi, cams gets its own directory and compose project next to
cam-proxy's, so updating one never touches the other. Any directory the admin
user can write works; ours is `/srv/cam-proxy/cams` (no sudo). Below, `$CAMS`
stands for it:

```bash
ssh <user>@<pi> 'mkdir -p /srv/cam-proxy/cams/data && id -u'
```

The container runs as uid 1000. If `id -u` printed 1000 (the Pi's first
user), nothing else is needed; otherwise make `data/` writable for it
(`sudo chown 1000:1000 $CAMS/data`) and `cameras.json` readable.

1. **`$CAMS/compose.yaml`**: copy [`deploy/pi/compose.cams.yaml`](../deploy/pi/compose.cams.yaml).
   Host networking, like cam-proxy: cams reaches cam-proxy at
   `http://127.0.0.1:8480` and listens on the Pi's port 8080 (cam-proxy uses
   8480, 2121, the FTP passive ports and go2rtc's; 8080 is free).
2. **`/srv/cam-proxy/config/.env`** (cam-proxy's, owner uid 1000, mode 600;
   cam-proxy's docs/raspberry-pi.md): add cams' two secrets, new and random,
   never printed, and link it as `$CAMS/.env`:

   ```bash
   ssh <user>@<pi> 'umask 077; { echo "COOKIE_SECRET=$(openssl rand -hex 32)"; echo "CAMS_LOGIN_TOKEN=$(openssl rand -hex 16)"; } >> /srv/cam-proxy/config/.env; ln -s ../config/.env /srv/cam-proxy/cams/.env'
   ```

   The whole file then looks like this (no values shown):

   ```sh
   CAMERA_HOST=<camera>
   PI_ADDRESS=<pi>
   CAMPROXY_TOKENS=
   CAMPROXY_ADMIN_TOKEN=
   CAMPROXY_CAMERA_PASSWORD=
   CAMPROXY_FTP_PASSWORD=
   CAMPROXY_GOOGLE_VISION_KEY=
   CAMPROXY_POE_SWITCH_PASSWORD=
   CAMS_LOGIN_TOKEN=
   COOKIE_SECRET=
   ```

   A `$CAMS/.env` from before this change (a real file with `COOKIE_SECRET`
   and `CAMS_LOGIN_TOKEN`): back it up, append both lines to
   `/srv/cam-proxy/config/.env` (after cam-proxy's move to `config/`), then
   replace the file with the link:

   ```bash
   cd /srv/cam-proxy/cams && umask 077
   cp -p .env ../config/cams-env.pre-config-$(date +%Y%m%d)
   grep -E '^(COOKIE_SECRET|CAMS_LOGIN_TOKEN|CAMS_TOKEN_USER|CAMS_TAG)=' .env >> ../config/.env
   rm .env && ln -s ../config/.env .env
   docker compose up -d --force-recreate
   ```

   Keeping the same `COOKIE_SECRET` keeps the sessions. `CAMS_TAG`, if a
   release is pinned, goes into `config/.env` too.

   Read the token on the Pi when you need it (`grep CAMS_LOGIN_TOKEN /srv/cam-proxy/config/.env`),
   or keep it in a password manager; the browser's password manager offers to
   save it at the first sign-in.
3. **`$CAMS/cameras.json`** (mode 600, readable by uid 1000, the container's
   user): start from [`deploy/pi/cameras.example.json`](../deploy/pi/cameras.example.json).
   - `proxy.url`: `http://127.0.0.1:8480`;
   - `proxy.token`: one of cam-proxy's `CAMPROXY_TOKENS`, and
     `proxy.adminToken`: its `CAMPROXY_ADMIN_TOKEN` (both in
     `/srv/cam-proxy/config/.env`; the admin token lets "Proxy" links sign in and
     renames go through the proxy);
   - `host`: `"from-proxy"`: cams asks cam-proxy for the camera's address
     (cam-proxy has it from `CAMERA_HOST`).
   - `user`, `password`: the camera's `cams` user, for what cams asks the
     camera directly (settings, the light, reboot, and the fallback when the
     proxy is down). When the `cams`
     user's password isn't available on the Pi, cam-proxy's camera user
     works as well: `user` `proxy` with `CAMPROXY_CAMERA_PASSWORD` from
     `/srv/cam-proxy/config/.env`. `tlsServername`
     `cam1.skylar.technology` (required with `"from-proxy"`) checks the camera's Let's Encrypt certificate
     by name while it is reached by address.

   The Pi has no site CA (cam-proxy spec 2026-10-05 §11): its `cameras.json`
   has no `caFingerprint`, the proxy stays at `http://127.0.0.1:8480`, and
   cam1 keeps its Let's Encrypt certificate checked against
   `cam1.skylar.technology`.

   Copy the secrets over without printing them, for example with `jq` on the
   Pi reading `/srv/cam-proxy/config/.env`, or write the file locally and `scp` it.
   A one-camera `cameras.json` like `deploy/pi/cameras.example.json` keeps
   working unchanged with multi-camera cam-proxies; `scripts/cameras-config.ts`
   can write it (see README, Generating cameras.json).
4. Start it:

   ```bash
   ssh <user>@<pi> 'cd /srv/cam-proxy/cams && docker compose pull && docker compose up -d'
   curl -s http://<pi>:8080/health     # {"status":"ok","version":"…"}
   ```

Open `http://<pi>:8080`, enter the token, and the Video page opens.

## On the road

Nothing in cams depends on the browser's address (there is no redirect URI,
and the same-origin check uses the address the browser asked for), and cams
takes the camera's address from cam-proxy, so a new LAN changes only
`/srv/cam-proxy/config/.env`, and cam-proxy's admin UI does most of it:

1. **The Pi's address** (whatever the new LAN gives it): set
   `PI_ADDRESS=<new pi>` in `/srv/cam-proxy/config/.env` and restart cam-proxy
   (`cd /srv/cam-proxy && docker compose restart`). Browse to
   `http://<new pi>:8080` for cams and `http://<new pi>:8480` for cam-proxy;
   cam-proxy's "Proxy" links and FTP address follow `PI_ADDRESS`.
2. **The camera's address:** in cam-proxy's admin UI, Settings → **Find
   camera** lists the cameras on the LAN; **Use this address** writes
   `CAMERA_HOST` into `.env` and restarts cam-proxy. cams picks the new
   address up when cam-proxy's stream comes back (no cams restart).
3. **"Point the camera's FTP here"** on cam-proxy's Maintenance page, so the
   camera uploads to the Pi's new address.

- Without internet the camera's certificate still checks (the chain is
  verified offline), as long as it hasn't expired: the cluster's CronJob
  renews it at home only.

## Day to day

| Task | Command (in `$CAMS`) |
|---|---|
| Update to the newest release | `docker compose pull && docker compose up -d` |
| Pin a release | `CAMS_TAG=v2026.10.05.1` in `/srv/cam-proxy/config/.env` (compose reads `${CAMS_TAG}` through the `.env` link), then the same |
| Restart (after editing `cameras.json` or `config/.env`) | `docker compose restart` (`up -d --force-recreate` after `config/.env`: a restart keeps the old environment) |
| Logs | `docker compose logs -f --tail 50` |
| Change the token | edit `CAMS_LOGIN_TOKEN` in `/srv/cam-proxy/config/.env`, then `docker compose up -d --force-recreate` here; every browser signs in again |
| Stop | `docker compose down` (cam-proxy keeps running) |

A token session lasts 7 days, like a Google one; then the start page asks for
the token again and returns to the page you were on.
