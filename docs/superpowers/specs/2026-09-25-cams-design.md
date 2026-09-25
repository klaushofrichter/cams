# cams: design

Date: 2026-09-25 · Status: draft for review

## 1. Purpose

`cams.skylar.technology` is a private, public-facing web app for viewing and
controlling Skylar Technology's Reolink security cameras from a desktop browser:
live video, a browsable record of detected events, clip playback and download,
and camera settings. One camera today (RLC-1224A "Den", id `cam1`); the design
supports several.

**Success looks like:** the single allowed account can sign in with Google, watch
live video with about 1 s latency, find any recorded event in the last 7 days
by time or by thumbnail, play it, download it in full quality, and change the
camera's main settings. Every deploy is gated by tests that exercise all of this
against a mock camera, so a green pipeline means a working app.

**Out of scope for now:** mobile-first optimisation (phones get a working,
responsive but best-effort experience), iPhone-grade live video (HLS), user
management beyond an email allow-list, continuous 24/7 recording (the camera
records event clips only), PTZ controls (the RLC-1224A is fixed), two-way audio.

## 2. Camera facts that shape the design

Measured on the RLC-1224A, firmware v3.2.0.6011:

- **Access:** HTTPS JSON API (`/cgi-bin/api.cgi`, token login). The camera has a
  Let's Encrypt certificate for `cam1.skylar.technology` (cert job in the
  `cam1` namespace), but inside the cluster that name resolves to Traefik, so
  the app connects **by LAN address** and pins nothing.
- **Streams:** sub stream H.264 896×512 @10 fps, main stream H.265 4512×2512 @20 fps,
  both with AAC audio. RTSP (554) and FLV-over-HTTPS both work. FLV and recording
  download require the camera's **RTMP service enabled** (it is now), and download
  started working once HTTP was also enabled (whether HTTP must stay on is an
  open check, §11).
- **Recordings:** event-triggered MP4 clips (typically 20–30 s) on the SD card,
  7-day retention, recorded on both streams. `Search` lists days with recordings
  and clips per day. `Download` returns a fragmented MP4 that a browser `<video>`
  can seek directly (sub clip ≈ 0.3–1.3 MB, main clip ≈ 5–17 MB).
- **Triggers:** AI person / vehicle / pet plus motion. The clip file name carries
  a hex flag field encoding the trigger (decoding as in the `reolink_aio` library).
- **Quirks:** `ImportCertificate` over an existing certificate silently does
  nothing (irrelevant to cams, recorded for completeness). The camera is weak
  hardware: few concurrent requests.

## 3. Architecture

One container, Knative service `cams` in namespace `cams`, pinned to one replica.

```
browser ──HTTPS──► Traefik ─► Knative ─► cams (Express 5, Node 26)
                                           ├─ serves Svelte SPA (static)
                                           ├─ /auth/*   Google OAuth
                                           ├─ /api/*    JSON + media proxy
                                           ├─ ffmpeg    thumbnails
                                           └─ cache     emptyDir: clips, thumbs
                                                 │ HTTPS (LAN)
                                                 ▼
                                           Reolink camera(s)
```

- **Backend:** Express 5 + TypeScript, following the sibling services
  (steps-service, kauf-server, www-klaushofrichter): pino logging, express-rate-limit,
  `/health`, calendar versioning, same Dockerfile shape.
- **Frontend:** Svelte 5 + Vite single-page app under `web/`, built to static
  files that Express serves. Routes: `/` (landing, public), `/app/live`,
  `/app/recordings`, `/app/settings`, `/app/about`.
- **Camera registry:** a Kubernetes Secret holds a JSON list
  `[{id, name, host, user, password}]`, mounted as a file. The app uses a
  **dedicated `cams` admin user** on each camera, separate from the owner's admin
  login and the certificate job.
- **Reolink client module:** one instance per camera. Caches the login token,
  re-logs in once on an auth error, applies a per-request timeout, and limits
  concurrency to 2 requests per camera. Exposes typed methods (`search`,
  `download`, `openLiveStream`, `getSettings`, `setSettings`, `reboot`, `status`).

### Media paths

| Feature | Route | Camera side | Browser side |
|---|---|---|---|
| Live | `GET /api/cameras/:id/live?quality=sub\|main` | FLV stream | mpegts.js via MSE |
| Playback | `GET /api/cameras/:id/clips/:clip?quality=sub` | `Download` (sub) | `<video>`, Range requests |
| Download | `GET /api/cameras/:id/clips/:clip/download?quality=sub\|main` | `Download` | file attachment |
| Thumbnail | `GET /api/cameras/:id/clips/:clip/thumb.jpg` | `Download` (sub) + ffmpeg frame | `<img>` |
| Snapshot | `GET /api/cameras/:id/snapshot.jpg` | `Snap` | `<img>` / save |

- **Live, and the Knative request timeout:** long responses are cut at the
  revision timeout. This cluster (Knative Serving 1.23.0, stock defaults) caps it
  at `max-revision-timeout-seconds` = 600, and the default is 300. So the ksvc
  sets `timeoutSeconds: 600` explicitly, and the player reconnects seamlessly
  every 9 minutes (it prepares a second connection and swaps). No cluster-wide
  config change is needed. Idle timeouts are infinite at Knative and Kourier, and
  Traefik sets no write timeout. A real test must confirm the cut comes at 600 s.
  `quality=main` (H.265) is offered only when
  `MediaSource.isTypeSupported` reports HEVC support.
- **Caching:** sub clips and thumbnails are cached in an `emptyDir`, capped at
  2 GiB with LRU eviction. Everything is rebuildable, so it needs no backup.
  Main-stream downloads stream through without caching.
- **Clip IDs:** an opaque, URL-safe ID derived from the camera file path. The
  server keeps the path mapping from `Search` and never accepts raw paths from
  the client.

### Recordings and events model

A clip is an event: `{id, cameraId, start, end, triggers[], sizeSub, sizeMain}`.
Triggers are decoded from the file name. `GET /api/cameras/:id/days?month=YYYY-MM`
returns days with recordings; `GET /api/cameras/:id/events?date=YYYY-MM-DD`
returns that day's clips. Times are camera-local (America/Chicago), and the API
returns ISO strings with offsets.

### Settings

- **App preferences** (per user, JSON file on a 64 Mi PVC `cams-data`): default
  camera, default live quality, default event filter, timeline zoom.
- **Camera settings** (read/write through typed routes mapping to Reolink
  commands; each write is re-read and shows success or failure):
  - **Detection and recording:** recording on/off, motion sensitivity, AI
    detection per type (person/vehicle/pet) and sensitivity.
  - **Image and lights:** IR / night-vision mode, spotlight/floodlight mode,
    day/night, OSD (name and time overlay).
  - **Device and maintenance:** model, firmware, storage used/total, certificate
    status (subject, expiry), reboot (with confirmation).

## 4. Authentication and security

- **Google OAuth**, as in steps-service: a state nonce cookie with a
  constant-time comparison, `openid email` scope, `verifyIdToken` with the
  client ID as audience, `email_verified` required, and one retry with the
  account chooser.
- **Allow-list:** `ALLOWED_EMAILS=klaus@klaushofrichter.net`, re-checked on
  every request (www pattern), so removing an address takes effect immediately.
- **Session:** a JWT cookie `session` (`COOKIE_SECRET`), httpOnly, secure,
  sameSite=lax, 7 days. Signed-out access:
  - `/app/*` returns 302 to `/`.
  - `/api/*` returns 401 JSON.
  - Authenticated responses are `Cache-Control: no-store`.
- **Logout** removes every cookie the app sets (session, OAuth state, return path). No
  `Clear-Site-Data` header: browsers apply it to the whole `skylar.technology` domain and would
  sign the user out of every sibling service too. Sign-in always shows Google's account chooser
  (`prompt=select_account`), so after Logout the user must actively sign in again rather than
  being let back in silently by an existing Google session. (Signing out of Google itself is out
  of scope.)
- **CSRF:** kauf-server's same-origin check on every non-GET API call.
- **`trust proxy`:** the cluster CIDR list `['loopback','10.42.0.0/16','10.43.0.0/16']`.
- **Rate limits:** on the auth callback and the API (IP-keyed); media routes get a
  higher budget.
- **Logging:** JSON via pino. Never logs camera passwords, tokens, cookies or
  client IPs. Camera tokens never reach the browser.
- **Container:** `USER 1000:1000`, non-root, all capabilities dropped,
  seccomp RuntimeDefault, read-only root filesystem (cache and data on volumes).
- **OAuth client:** its own client "cams" in Google Cloud project `1004218987196`,
  redirect `https://cams.skylar.technology/auth/google/callback`.

## 5. UI

- **Visual direction "Midnight Steel":** navy surfaces (`#0B1220` base,
  `#0F1829` chrome), text `#E6EDF7`, accent gradient teal `#22D3EE` → indigo
  `#6366F1`, live/alert red `#EF4444`. A matching light theme uses cool white
  surfaces with the same accents. All colours are CSS custom properties.
  - The theme follows `prefers-color-scheme` until toggled; the choice is stored
    in `localStorage`.
  - Scrollbars are themed (`scrollbar-color` plus `::-webkit-scrollbar-*`).
- **Brand mark "Lens":** a lens with a glint on the gradient tile. Used as the
  SVG favicon, 32/180/512 PNGs (Apple touch and manifest icons) and the top-bar logo.
- **Landing page (public):**
  - "cams by Skylar Technology LLC", a headline and a two-sentence description.
  - "Sign in with Google", feature chips, and an illustrated SVG of the turret
    camera (no third-party product photo).
  - A footer with "© Skylar Technology LLC".
  - Signed-in visitors are redirected to `/app/live`.
- **App shell:**
  - **Top bar:** logo, camera picker, version link (monospace, dimmed, brighter on
    hover, linking to `https://github.com/klaushofrichter/cams`), theme toggle,
    Logout.
  - **Sidebar:** 220 px with labels, collapsing to a 64 px icon column; animated
    width and label fade. The state is remembered.
  - **Below 768 px:** a hamburger button top-left opens a slide-in drawer, which
    also holds the theme toggle and Logout.
  - **Motion:** page transitions and hover states animate; everything respects
    `prefers-reduced-motion`.
- **Menu:** Live, History, Events, Downloads, Settings, About. History, Events
  and Downloads all open the **Recordings workspace** with the matching panel
  selected.
- **Live page:**
  - The player with a LIVE badge, sub/HD toggle, snapshot, fullscreen and mute.
  - A "camera offline" state with retry.
  - A mini timeline of today's events underneath; clicking one opens it in
    Recordings.
- **Recordings workspace:**
  - The player: play/pause, −10 s / +10 s, previous/next clip, download.
  - A day timeline with coloured segments (AI events bright, motion muted), the
    time cursor, drag and scroll zoom, and hour ticks. A date picker enables only
    days with recordings.
  - An Events panel: thumbnail cards with time, duration and trigger tags, plus a
    trigger filter.
  - A Downloads panel: clips around the cursor, each with Sub and Full-quality
    download and its size.
  - Responsive layout:
    - **≥ 1200 px:** the panel sits right of the player.
    - **768–1199 px:** the panel moves below, as a two-column grid.
    - **< 768 px:** everything stacks in one column.
- **Shared time cursor:** one store `{cameraId, time, clipId}`, mirrored into the
  URL (`/app/recordings?cam=cam1&t=2026-09-25T13:58:01-05:00&panel=events`) so
  reload, back/forward and bookmarks work. Switching camera keeps the time.
- **Settings page:** cards for App preferences, Detection and recording, Image
  and lights, and Device and maintenance. Camera changes save explicitly per card.
- **About page:** version, build date, repo link, supported cameras (model,
  firmware), credits and licences.

## 6. Error handling

- **Camera unreachable or timed out:** the API returns 503 with `{code:"camera_offline"}`.
  The UI shows an offline banner per camera and keeps the rest of the app working.
  `GET /api/cameras/:id/status` reports online, the last error and the firmware.
- **`/health`:** depends only on the process, never on the camera, so an offline
  camera never restart-loops the pod. It returns `{status:"ok", version}`.
- **Auth:** a camera session expiry triggers one transparent re-login; repeated
  failures surface as `camera_auth_failed` without retry storms (exponential
  backoff, at most 1 login per 30 s per camera).
- **Streams:** stream errors on the server close the response cleanly; the player
  retries with backoff and shows its state.
- **Settings writes:** partial failures are reported per field.

## 7. Testing

- **Mock Reolink camera** (`test/mock-camera/`): an Express app implementing
  `Login`, `Search`, `Download`, `Snap`, the settings commands, and FLV live from
  fixture files (short CC0 test clips generated with ffmpeg, not real footage).
  Used by unit tests, e2e and local development (`npm run dev:mock`).
- **Unit and integration (vitest + supertest):**
  - The Reolink client: token reuse, re-login, timeouts, concurrency limit.
  - File-name trigger decoding.
  - Clip-ID mapping, and rejection of unknown IDs.
  - The OAuth flow: state checks, allow-list, `email_verified`.
  - Session and allow-list re-check, the same-origin check, rate limits.
  - Cache eviction, settings validation, `/health`.
  - Frontend stores and URL sync.
- **End-to-end (Playwright, Chromium, desktop 1440×900 and phone 390×844):**
  - Landing page and its auth redirects.
  - Test login via a signed session cookie (the steps/www pattern: tests sign a
    JWT with the test `COOKIE_SECRET`; there is no test route in the app).
  - Sidebar collapse and expand, the hamburger drawer, theme toggle
    (including the computed scrollbar colours), version link.
  - Live: the video element reaches `readyState ≥ 2` with advancing
    `currentTime`; offline banner when the mock camera is stopped.
  - Recordings:
    - A timeline click plays the right clip; ±10 s and previous/next work.
    - The event filter works; the cursor carries across panels and page switches.
    - Deep links restore state; a download returns an MP4 with the right name.
  - Settings: saving shows the success state; a mock failure shows the error state.
- **CI:** Playwright runs on GitHub-hosted runners, never on the self-hosted runner.
- **Post-deploy smoke test (in `deploy-production.yml`):**
  - `/health` reports the stamped version (polled until it does).
  - `/` returns 200 with the landing page.
  - `/app/live` signed out returns 302, which proves auth is enforced.
  - `/api/cameras` signed out returns 401.

## 8. Repository and CI/CD

The `klaushofrichter/cams` repo is public, and follows kube-setup's
`repository-baseline.md` and `cluster-deployment-requirements.md`:

- **Workflows:**
  - `production-checks.yml` (PRs to main/production): jobs `test` (unit, build,
    `npm audit --audit-level=high`), `e2e`, and `codeql` (zero-findings gate).
  - `build-push.yml` (push to main): tests, then pushes `:main` only.
  - `deploy-production.yml` (push to production, `[self-hosted, k3s]`):
    1. Calendar version `YYYY.MM.DD.N`, dated America/Chicago.
    2. Build and push `:<sha>`, `:v<ver>` and `:latest`.
    3. `sed` the image line in kube-setup's `manifests/cams/cams-ksvc.yaml`,
       grep-verify it, then push before applying.
    4. Wait for Ready, then run the smoke test.
    5. Create a GitHub release with "Verified at release".
- **Branches:** `main` → PR → `production`; `production` is protected with the
  required checks `test`, `codeql` and `e2e`.
- **Dependabot:** `dependabot.yml` (npm, actions, docker) plus alerts and
  security fixes switched on in the repo settings.
- **Node 26** in the Dockerfile, `setup-node` and `@types/node`. Action pins
  follow the baseline.
- **Docs:** README with badges, `CHANGELOG.md` with `[Unreleased]`, `CLAUDE.md`,
  `.env.example`, and a LICENSE (MIT, as kauf-server).
- **Layout:** `server/` (TS), `web/` (Svelte), `test/` (vitest + mock camera),
  `e2e/` (Playwright), `docs/`.

## 9. Cluster integration

The kube-setup session makes these changes; service sessions don't edit kube-setup.

- **Namespace `cams`:**
  - The ksvc with `min-scale`/`max-scale` 1, the non-root securityContext and
    `timeoutSeconds: 600`.
  - `envFrom` Secret `cams-oauth`, and Secret `cams-cameras` mounted as a file.
  - An `emptyDir` cache of 2 GiB and PVC `cams-data` (64 Mi).
  - `DomainMapping` plus `ClusterDomainClaim` for `cams.skylar.technology`.
  - Pod egress to the camera LAN is already proven by the cert job.
- **Namespace `cams-runner`:**
  - A self-hosted runner registered with `CAMS_GITHUB_PAT` (Secret `runner-pat`).
  - RBAC limited to updating the one ksvc.
- **Other kube-setup changes:**
  - Add the namespaces to `scripts/export.sh` and `bootstrap.sh`.
  - Add `cams` to the version-exporter (services dashboard).
  - No alerting change needed: the "TLS certificate is not renewing" rule
    already covers every certificate, including the new one.

## 10. Owner actions

1. **DNS:** Squarespace A record `cams.skylar.technology` → the current public IP.
2. **Secrets:** create them with the provided script, which reads `.env` and
   never prints values:
   - `cams-oauth`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
     `ALLOWED_EMAILS`, `COOKIE_SECRET`.
   - `cams-cameras`: the camera registry.
   - The OAuth client itself is already created.
3. **Repo secret:** set `KUBE_SETUP_DEPLOY_TOKEN` on the repo, as for the
   sibling services.

## 11. Open checks before or during implementation

- Whether camera HTTP (port 80) can be turned off again without breaking `Download`.
- Creating the `cams` camera user: whether a second admin account on this
  firmware has the same API rights, including settings and reboot.
- A live stream of more than 10 minutes through the real ingress, to confirm the
  cut comes at 600 s and the 9-minute swap is seamless.
- Trigger-flag decoding verified against real clips of each type (person,
  vehicle, pet, motion).
