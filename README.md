# cams

[![Release](https://img.shields.io/github/v/release/klaushofrichter/cams)](https://github.com/klaushofrichter/cams/releases)
[![PR checks](https://github.com/klaushofrichter/cams/actions/workflows/production-checks.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/production-checks.yml)
[![Build and publish image](https://github.com/klaushofrichter/cams/actions/workflows/build-push.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/build-push.yml)
[![Deploy production](https://github.com/klaushofrichter/cams/actions/workflows/deploy-production.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/deploy-production.yml)
<!-- Static badge: Dependabot has no status endpoint; alerts and security fixes are enabled in repo settings. -->
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot&logoColor=white)](https://github.com/klaushofrichter/cams/security/dependabot)

Private viewer for Skylar Technology's Reolink security cameras, at
<https://cams.skylar.technology>: live video, recorded events with AI detection,
clip playback and downloads, and camera settings, behind Google sign-in.

## How it fits together

- `server/`: Express 5 + TypeScript. Google OAuth, sessions, `/health`, the JSON API, and serving the web build.
- `web/`: Svelte 5 + Vite. `index.html` is the public landing page; `app.html` is the signed-in app.
- The app runs as a Knative service `cams` (namespace `cams`) on the k3s cluster. Its manifests live in the `kube-setup` repo, not here.
- Notes on the camera's HTTP API, as measured on the real camera: [docs/reolink-api.md](docs/reolink-api.md).
- **cam-proxy (optional, per camera):** a camera can have a [cam-proxy](https://github.com/klaushofrichter/cam-proxy), a gateway that keeps the one camera connection, stores a still per second and receives the camera's clips by FTP. cams talks to it server-side (`server/proxy/`), with the token from the camera's `proxy` entry:
  - **Events at once:** one event-stream subscription per proxied camera (resuming after drops) is relayed to browsers as `GET /api/events/stream`. Recordings and Live reload on a new event or clip instead of polling every minute. Polling continues for cameras without a proxy, and while a proxy is down.
  - **Timeline:** the Timeline page (in the menu when some camera has a proxy) shows a day's stills as one tile per minute, marks recording minutes, and on cam-proxy's model opens a minute's 60 seconds under its hour (◀ ▶ and the arrow keys step within the hour). A second opens the large still; "Open in History" opens History there, paused. History's "Show in Timeline" (in the line under the video) opens the Timeline at the player's moment.
  - **Vision:** where the camera's cam-proxy analyses events with Google Vision, a card shows Vision's confidence next to the camera's label ("✦ Vision 84%"), "✦ Vision: not confirmed" when Vision found none, or an extra finding ("+ Pet 70%"); the tooltip names what Vision saw. The Timeline marks analysed minutes and seconds in purple and draws Vision's boxes on the analysed still ("Show all objects" draws everything it reported). The camera's labels never change; the proxy's raw answer stays with the proxy.
  - **Clips first from the proxy:** a recording plays from the clip the camera uploaded to the proxy (with seeking); the camera is asked only when the proxy has none. Downloads: the sub stream from the proxy (`…-proxy.mp4`), full quality from the camera (the proxy's clip if the camera refuses). The camera should upload the sub stream (cam-proxy `ftp.stream: sub`: H.264, plays in every browser).
  - **Downloads:** every History card and the player have a download button, which opens the "Save clip" dialog; nothing downloads until its Save. It offers SD or 4K (the camera's original main stream, saved as it is). With a cam-proxy it also offers a composed clip with a pre-/post-roll (−600…60 s each, up to 1:00 in all) filled from other clips, the proxy's stills (1 fps) or "No recording" cards, optionally marked "STILLS 1 FPS", at SD, 640×360, 1280×720 or 1920×1080. cam-proxy encodes it (`/api/cameras/:id/compositions`, passed through): a progress bar, Cancel, a preview, Save. 4K can't take a pre- or post-roll.
  - **Event thumbnails** are the proxy's first still 2–12 s into the event (a JPEG): no clip transfer, no ffmpeg. Without one, a frame from the clip as before.
  - **History strip:** the playhead stays centred and playback runs in real time through clips, the proxy's stills (1 fps, 24 h) and preview tiles (1 fps, 72 h), and stretches without anything ("No recording"), across days; a badge names the source. On the Live panel the strip's right end is the live stream: the playhead follows now; moving back switches to History at that moment, and ⇥ while playing (or playback catching up) is Live again. A line and the time follow the pointer, and a band of small frames runs under the strip. Zooms: 24, 12, 6, 3, 1 h and 30 min. Hovering the strip shows that moment's frame.
  - **Live fallback:** while live video isn't playing for 5 s (or the camera is offline), Live shows the proxy's newest still, updated every second, marked STILLS with the still's time and age (the line under the video says STILLS instead of LIVE).
  - **Switch:** Settings has a "cam-proxy" card for a camera with a proxy. Switching it off makes cams ignore the proxy for everyone (clips, thumbnails, stills and events from the camera only; the event subscription stops) until it is switched on again. The choice is kept in `proxy-state.json` (see `PROXY_STATE_FILE`) and survives restarts; thumbnails already cached stay.

## Pages and API

- **Pages** (`/app/…`): one video page with two panels beside the same player and strip: Live (`/app/live`, the strip's live end) and History (`/app/recordings?panel=history&cam&date&at`; old `panel=events`, `panel=downloads` and `clip&t` links open History); Timeline (cameras with a cam-proxy; `?cam&date&t`; a minute opens its seconds under its hour and a second its still; from the menu it opens at History's position, or the newest minute after Live); Settings (the camera's settings, the cam-proxy switch, reboot); About (version, build date, cameras).
- **API** (all need the sign-in cookie and answer JSON 401 otherwise; changes need the same origin; `Cache-Control: no-store`):
  - `GET /api/me`, `GET /api/cameras`, `GET/PUT /api/preferences`, `GET /api/cameras/:id/extent` (`{oldest}`: the oldest content on the SD card or at the cam-proxy), `GET /api/cameras/:id/status` (online, model, firmware, `simulator` when it is cam-sim, and the main/sub `streams`, cached 10 min);
  - per camera `/api/cameras/:id/…`: `status`, `snapshot.jpg`, `live` (at most 4 per camera), `days`, `events`, `settings` (`PUT settings/:section`), `device`, `POST reboot`, `light` (`GET`, `PUT {"on":true|false}`: the camera's manual light, `WhiteLed.state`);
  - clips: `/api/cameras/:id/clips/:clipId/video|thumb.jpg|download?quality=sub|main`;
  - cam-proxy: `PUT /api/cameras/:id/proxy` (`{"enabled": true|false}`, for all users; 404 `no_proxy` without one), `/api/cameras/:id/previews`, `previews/:minute.jpg`, `stills`, `stills/:ts.jpg`, `still/latest.jpg`, and `GET /api/events/stream` (SSE, at most 20 browsers, a ping every 25 s).

## Cameras

The cameras come from a JSON array in the file named by `CAMERAS_FILE`; in the cluster that is the Secret `cams-cameras`. A missing file means no cameras; invalid JSON or a bad field stops the server at start.

| Field | | |
|---|---|---|
| `id` | required | lowercase letters, digits and dashes, up to 32 characters, unique |
| `name`, `host`, `user`, `password` | required | `host` is an address or name, with an optional `:port` |
| `protocol` | optional | `https` (default) or `http` |
| `tlsServername` | optional | check the camera's certificate against this name (for a camera reached by address) |
| `webUiUrl` | optional | the link to the camera's own web page; `null` for none. Default: `https://<host>/` (without the port), or no link when only `webUiNote` is set |
| `webUiNote` | optional | 1 to 120 characters, shown instead of a link |
| `proxy` | optional | `{"url": "http://cam-proxy…:8480", "token": "<cam-proxy client token>", "adminToken": "<optional: its admin token>", "camera": "<optional>"}`: the camera's [cam-proxy](https://github.com/klaushofrichter/cam-proxy). With `adminToken`, the links to the proxy's UI sign a cams user in with a one-time link (`POST /api/cameras/:id/proxy/login-link`); without it they open the proxy's token login. `url` is http(s) without credentials, query or hash; `token` has 32+ characters and no spaces; `camera` is the proxy's id for this camera when it differs from `id`. With it, events arrive at once, the Timeline page shows its stills, and recordings and thumbnails come from the proxy first (see above). The token stays on the server; browsers only learn that a proxy exists. Without it (or while the proxy is down) cams works as before. |

Production has two cameras:

- `cam1` "Den": the real Reolink RLC-1224A, with its own Let's Encrypt certificate for `cam1.skylar.technology` (no cam-proxy yet: it comes with the Raspberry Pi next to the camera);
- `cam2`: a [cam-sim](https://github.com/klaushofrichter/cam-sim) simulated camera in the same cluster (`cam2.cam-sim.svc.cluster.local`, TLS name `cam2.skylar.technology`), whose web page `https://cam2.skylar.technology/` works on the LAN only. It has a `proxy` entry: cam-proxy in the cluster (`http://cam-proxy.cam-proxy.svc.cluster.local:8480`).

`scripts/create-camera-user.sh` creates the dedicated `cams` user on the real camera and writes its entry (`cam1`) into `cams-cameras`, keeping the other cameras.

## Development

```bash
npm ci
cp .env.example .env     # fill in values
npm run dev              # server on :8080
npm run dev:web          # Vite on :5173, proxying /api and /auth to :8080
```

The Google OAuth client must list the redirect URI: `http://localhost:8080/auth/google/callback` locally, `https://cams.skylar.technology/auth/google/callback` in production.

| Variable | Default | |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `COOKIE_SECRET`, `ALLOWED_EMAILS` | required | `ALLOWED_EMAILS` is comma-separated |
| `CAMERAS_FILE` | none (no cameras) | see [Cameras](#cameras) |
| `PORT` | `8080` | |
| `LOG_LEVEL` | `info` | |
| `PREFS_FILE` | `$TMPDIR/cams-preferences.json` | per-user preferences |
| `PROXY_STATE_FILE` | `proxy-state.json` next to `PREFS_FILE` (else `$TMPDIR/cams-proxy-state.json`) | cameras whose cam-proxy is switched off on Settings |
| `CACHE_DIR`, `CACHE_MAX_BYTES` | `$TMPDIR/cams-cache` (the image: `/var/cache/cams`), 1.5 GiB | downloaded clips and thumbnails |
| `FFMPEG_PATH` | `ffmpeg` | for thumbnails |
| `RECORDINGS_PROBE_MS`, `DOWNLOAD_RETRY_DELAY_MS` | `60000`, `1000` | how often a camera whose downloads fail is retried; the pause before a download's one retry |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_API_MAX`, `RATE_LIMIT_MEDIA_MAX` | 5 min, `40`, `600`, `3000` | per window: sign-in, API, media (clip video/thumbnails/downloads and the proxy's sprites and stills) |
| `APP_VERSION`, `BUILD_DATE`, `WEB_DIST` | `dev`, none, the built `web/` | set by the image build (shown on About and by `/api/me`); where the web build is |

`scripts/create-secrets.sh` creates the cluster Secrets `cams-oauth` (namespace `cams`) and `runner-pat` (namespace `cams-runner`) from `~/Development/reolink/.env`, keeping an existing `COOKIE_SECRET`. `npm run icons` regenerates the web icons; `npm run check` type-checks `web/`.

## Testing

```bash
npm test                 # vitest: server + web libraries (node) and Svelte components (jsdom)
npm run build && npm run test:e2e   # Playwright, desktop and phone viewports
```

Both suites need **ffmpeg** on the `PATH`, and e2e needs **Google Chrome**. The e2e suite signs its own session cookie with a test secret (`e2e/session.ts`), so it never talks to Google.

**The tests use [cam-sim](https://github.com/klaushofrichter/cam-sim) as the camera.** cam-sim simulates the Reolink RLC-1224A's HTTP API, quirks included, and can switch on faults (refused downloads, failing settings writes, offline, and more). cams has no mock camera of its own.

- **Unit tests** start cam-sim in the test process through `test/camera/sim.ts` (`createSimCamera`). `test/camera/warm.ts` builds cam-sim's test-pattern media once, before the tests run.
- **e2e** starts four cam-sim processes (`e2e/sims.ts`), listed in `e2e/cameras.json`:
  - "Den", with a cam-proxy;
  - "Porch", which rejects `SetWhiteLed`;
  - "Shed", which refuses downloads like the real camera;
  - "Barn", which refuses downloads too but has a cam-proxy whose clip plays, and whose live stream always resets, so Live shows the proxy's stills.

  A fifth camera, "Garage", points at an unused port and stays offline.
- **cam-proxy in tests** is a small fake (`test/proxy/fakeProxy.ts`) that follows cam-proxy's `openapi.yaml` for the stream, clips, stills and previews. Unit tests set its data directly; e2e runs it as a process, seeded with ffmpeg test patterns (`e2e/fakeProxyData.ts`). The real round trip is checked against cam-proxy in the cluster.
- **Version:** cam-sim is a dev dependency pinned to a release tarball in `package.json`. To update it, change the URL to the new release's `cam-sim-<tag>.tgz` asset, run `npm install`, and run both suites.
- **The other direction:** cam-sim's own CI runs cams' unit and e2e suites against every cam-sim change, so a simulator change that would break cams fails there first.

## Deployment and releases

`main` is built and published as `ghcr.io/klaushofrichter/cams:main` but never deployed. Every PR to `main` or `production` runs `test`, `e2e` and `codeql`. Merging a PR from `main` to `production` deploys through the in-cluster runner, smoke-tests the public URL and creates a `vYYYY.MM.DD.N` release. The release notes come from the `[Unreleased]` section of `CHANGELOG.md`, which the workflow then empties on `main`.

## Security

- **Sign-in:** Google OAuth with an email allow-list re-checked on every request.
- **Session:** an httpOnly, Secure, SameSite=Lax cookie.
- **Other protections:** a same-origin check on state-changing API calls, and rate limits on sign-in and the API.
- **Container:** runs as uid 1000 with all capabilities dropped.
