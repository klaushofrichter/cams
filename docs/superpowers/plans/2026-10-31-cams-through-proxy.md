# cams through the proxy (onboarding part C, cams side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Depends on the release of the cam-proxy plan** `cam-proxy` `docs/superpowers/plans/2026-10-31-camera-calls-for-cams.md` (the `camera-calls` feature: camera status, snapshot, live over WebSocket, settings, light, reboot; Part A's password API and trust pin for managed admin tokens). Start once that cam-proxy release is out; Task 11 pins its image for the real-proxy e2e.

**Goal:** For a camera whose proxy announces `camera-calls`, every camera call of cams goes through that proxy, cams holds no password for it, its Camera login and Trust dialogs relay to the proxy, and the viewer's camera-trust machinery no longer applies to it; cameras without a proxy (or with an older one) keep today's direct calls.

**Architecture:** A per-proxy switch, `throughProxy(id)`, comes from the features the proxy lists in `GET /api/cameras`, kept in a small state file so a restart with the proxy down still knows it (`server/proxy/features.ts`). The routes that call `server/reolink/*` today branch on it to `server/proxy/cameraCalls.ts` (reads with the client token, camera-changing calls with the proxy-admin token cams already holds per proxy) and `server/proxy/live.ts` (an undici WebSocket to the proxy, relayed to the browser as chunked HTTP fMP4 on the existing live route). The browser gets an fMP4 MSE player beside the mpegts.js one. The fleet build skips camera passwords and camera-trust holds for through-proxy cameras, and stored passwords for them are removed from the local credentials file.

**Tech Stack:** TypeScript (Node 26), Express 5, undici ^8 (`WebSocket` with `headers` and `dispatcher`), Svelte 5, vitest (node + components projects), Playwright, the fake proxy (`test/proxy/fakeProxy.ts`; `ws` as a new devDependency for its WebSocket), cam-sim, ffmpeg (fake live stream).

**Spec:** `cam-proxy` `docs/superpowers/specs/2026-10-30-camera-onboarding-design.md` — §6 (cams through the proxy, Camera login and Trust dialogs), §8 (per-proxy switch, no direct fallback, password removal), §10.1–§10.3 (tokens, trust, live transport: browser → cams stays chunked HTTP, cams → proxy is a WebSocket).

## Prerequisites

- **cam-proxy release with `camera-calls`** (above). Nothing else in cam-proxy.
- **cam-sim: none** (cams's direct-call tests keep the pinned tarball; through-proxy tests use the fake proxy and, in CI, the real proxy image).
- **cams-admin contract: none.** No report field changes (the cleanup is logged, not reported).
- **kube-setup (Klaus / the Cluster session, after this release is verified; not done by cams code):** (1) remove the proxied cameras' entries from the `cams-camera-credentials` Secret, (2) once no camera of the cluster's cams is reached directly, retire that Secret and the `CAMERA_CREDENTIALS_FILE` mount from `manifests/cams/`. Task 11 writes this as a request in `docs/` and Slack, it does not edit kube-setup.

## Global Constraints

- `throughProxy(id)` is true exactly when the camera has a proxy and that proxy (by account id and URL) last listed `camera-calls` in an item's `features`. For such a camera: no `server/reolink/*` call on any path, no direct fallback (a proxy that is down shows the camera offline, `proxy_unreachable`), no camera password held, no camera certificate pin or held camera connection data.
- Reads use the proxy client token (`getProxyClient`); camera-changing calls (settings PUT, light PUT, reboot, name, password, trust pin) use the proxy-admin token (`proxy.adminToken`) with `groupTrustOptions(id)`. No admin token: 403 `proxy_admin_missing`, and the UI says to use the proxy's admin page.
- A password typed in the Camera login dialog goes only to the proxy's `PUT /control/cameras/:cam/password`; it is never stored, logged or echoed. cams logs `camera_password_relayed` `{cameraId, outcome, by}`. The trust pin sends only the fingerprint the proxy reported (`tls.served`), never a typed one.
- The browser → cams live leg stays chunked HTTP on `GET /api/cameras/:id/live` (Knative breaks WebSocket upgrades); the 9-minute swap (`SWAP_AFTER_MS`) stays. Through-proxy answers `Content-Type: video/mp4; codecs="…"` (fMP4), direct ones `video/x-flv` as today.
- Every camera is a `CamKey`; routes resolve `:id` only through `knownCamera`; answers carry camsIds (`outId`). Every new `/api` route has a line in `server/routes/access.ts`.
- Error answers keep today's shapes where the web reads them (`{error}` codes, `bad_request` with `details` for settings, `reboot_cooldown`, `not_applied`).
- Never log camera passwords, tokens, cookies or client IPs. Colours from `web/src/styles/theme.css` only. Every new UI element used by e2e has a `data-testid`; e2e runs at 1440x900 and 390x844.
- The fake proxy follows cam-proxy's routes and answers for everything added here. User-visible changes under `## [Unreleased]` in CHANGELOG.md. Stage files explicitly.

## Review Focus

1. **The proxy goes down after the switch**: the camera shows offline with `proxy_unreachable` and cams never calls the camera (it has no password; a direct try would also break "no camera calls"). Test in Task 11 (cam-sim's login attempts stay 0 while the fake proxy is stopped).
2. **The proxy is rolled back to a release without `camera-calls`** after cams removed the stored password: the next successful list read turns the switch off, the camera goes back to direct calls and shows the existing "no password" state and Camera login — not a blank page or a loop. Test in Task 1.
3. **The trust fingerprint changed between showing and confirming**: cams re-reads the proxy's status before pinning and answers 409 `fingerprint_changed` (the dialog shows the new one); the proxy's own check stays the last word (its 409 `fingerprint_mismatch` maps to the same answer). Test in Task 8.
4. **A viewer or the proxy leaves mid-stream**: both the browser response and the proxy WebSocket close, the per-camera live slot (`MAX_LIVE_PER_CAMERA`) is freed, and a viewer that stops reading (more than 4 MiB queued in the response) is cut instead of buffering. Test in Task 6.
5. **The same proxy URL in two accounts, or a camera moved to another proxy URL**: features are kept per account and URL; a camera on a URL not read yet stays direct until that proxy's list is read. Test in Task 1.

---

### Task 1: The per-proxy switch

**Files:**
- Create: `server/proxy/features.ts`, `test/proxyFeatures.test.ts`
- Modify: `server/proxy/names.ts` (note features on every list read), `server/routes/proxy.ts` (list read at `:65`; the Settings switch), `server/cameraRegistry.ts` (`proxyActive`, `CameraSummary.throughProxy`, `listCameras`), `server/server.ts` (load at start), `test/proxy/fakeProxy.ts` (`features` per instance from `FAKE_PROXY_FEATURES`)

**Interfaces:**
- Produces (`server/proxy/features.ts`):
  - `export const CAMERA_CALLS = 'camera-calls'`
  - `export const proxyFeaturesFile = (): string` — `PROXY_FEATURES_FILE`, else `proxy-features.json` in `PREFS_FILE`'s folder, else the temp folder (as `server/proxyState.ts`).
  - `export function loadProxyFeatures(): void` — a missing or bad file is empty.
  - `export function noteProxyFeatures(accountId: string, proxyUrl: string, list: unknown): Promise<void>` — the union of the items' `features` strings matching `^[a-z0-9-]{1,32}$` (at most 32); written atomically (temp + rename) only when it changed; when `camera-calls` flips, emits `featureEvents` `'through'` `{ accountId, proxyUrl, on: boolean }`. File shape `{v: 1, proxies: {<key>: {features: string[], at: number}}}`, key = the first 32 hex of sha256(`${accountId}\u0000${url without trailing slashes}`) (no token, no URL in the file).
  - `export function throughProxyAt(accountId: string, proxyUrl: string): boolean`
  - `export function throughProxy(id: CamKey): boolean` — `getCamera(id)?.proxy` and `throughProxyAt` for its account and URL.
  - `export const featureEvents: EventEmitter`
- Produces: `proxyActive(id)` is true for a through-proxy camera whatever the Settings switch says; `PUT /api/cameras/:id/proxy` with `enabled: false` for it answers 409 `proxy_required`. `CameraSummary.throughProxy: boolean`.
- Produces: on `'through'`, `reapplyConfig()` and `resetClients()` run once (Task 9 hangs its cleanup on the same event).

- [ ] **Step 1: Write the failing tests** (`test/proxyFeatures.test.ts`):

```ts
it('turns a camera through-proxy when its proxy lists camera-calls, and back on a rollback', async () => { /* fake proxy features ['ptz','camera-calls'] → refreshProxyName → throughProxy true; features ['ptz'] → false; 'through' emitted twice */ });
it('keeps the switch over a restart with the proxy down', async () => { /* write, loadProxyFeatures() again → still true */ });
it('keys by account and URL', async () => { /* same URL, other account → false; camera moved to another URL → false until that list is read */ });
it('ignores junk in features and a failed list read', async () => { /* [1, 'A B', 'x'.repeat(40)] dropped; a 500 changes nothing */ });
it('stores neither the token nor the URL in the file', async () => {});
it('refuses switching a through-proxy camera to direct (409 proxy_required)', async () => {});
it('lists throughProxy per camera in GET /api/cameras', async () => {});
```

- [ ] **Step 2: Run** `npx vitest run test/proxyFeatures.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the module, the calls in `names.ts` (`refreshProxyName`, `refreshCapabilities`) and `routes/proxy.ts` after a successful list read, `proxyActive`, the 409, `listCameras`, and in the fake's CLI (`require.main` block) `FAKE_PROXY_PORT` and `FAKE_PROXY_FEATURES` from the environment (comma list; unset: today's port and `fake.features`).
- [ ] **Step 4: Run** `npx vitest run test/proxyFeatures.test.ts test/proxySwitch.test.ts test/cameraRegistry.test.ts test/proxyCameraList.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/proxy/features.ts server/proxy/names.ts server/routes/proxy.ts server/cameraRegistry.ts server/server.ts test/proxy/fakeProxy.ts test/proxyFeatures.test.ts
git commit -m "feat: per-proxy switch to camera calls through the proxy"
```

---

### Task 2: The proxy's camera calls (client)

**Files:**
- Create: `server/proxy/cameraCalls.ts`, `test/proxyCameraCalls.test.ts`
- Modify: `server/proxy/client.ts` (`ProxyErrorCode` gains `proxy_admin_missing`), `server/recordings/clipNames.ts` (`timeInfoFromProxy`), `test/proxy/fakeProxy.ts` (`GET /api/cameras/:cam/status`)

**Interfaces:**
- Produces (`server/proxy/cameraCalls.ts`):
  - `export interface ProxyCameraStatus { online: boolean; error: string | null; model: string | null; firmware: string | null; hardware: string | null; name: string | null; simulator: string | null; streams: { main: StreamInfo | null; sub: StreamInfo | null }; sd: { mounted: boolean; capacityMB: number | null; freeMB: number | null } | null; time: TimeInfo | null; certificate: { subject: string; issuer: string; validTo: string } | null; credentials: { source: 'env' | 'store' | 'none'; authOk: boolean | null }; tls: { mode: string; served: string | null; problem: 'untrusted' | 'changed' | null } }` (`StreamInfo` from `server/reolink/client.ts`).
  - `export function parseProxyStatus(v: unknown): ProxyCameraStatus | null` — every field checked; anything odd is null (the whole answer null when `online` is not a boolean).
  - `export function readProxyStatus(id: CamKey, o?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ProxyCameraStatus>` — `GET <proxyPath(id, '/status')>` with the client token; throws `ProxyError`.
  - `export function proxyAdminClient(id: CamKey): ProxyClient` — a `ProxyClient` with `proxy.adminToken` and `groupTrustOptions(id)`; throws `ProxyError('proxy_admin_missing', …)` without one.
  - `export function proxyTimeInfo(id: CamKey): Promise<TimeInfo>` — `status.time`, cached 1 h per camera, concurrent callers share one read (as `ReolinkClient.timeInfo`).
  - `export function resetProxyCameraCalls(): void` (tests).
- Produces (`clipNames.ts`): `timeInfoFromProxy(v: unknown): TimeInfo | null` — cam-proxy's `{stdOffsetMinutes, dstOffsetMinutes, dstRule: {startMon, startWeek, startWeekday, startHour, startMin, endMon, …} | null}` to cams's `TimeInfo` (`dstRule.start/end = {mon, week, weekday, minutes}`).

- [ ] **Step 1: Write the failing tests**: `parseProxyStatus` keeps a full answer and nulls each bad field; `timeInfoFromProxy` gives the same `offsetAt` as `timeInfoFromGetTime` for the cam-sim US rule on both DST edges; `readProxyStatus` against the fake proxy; `proxyAdminClient` without `adminToken` throws `proxy_admin_missing`; two `proxyTimeInfo` calls at once make one request.
- [ ] **Step 2: Run** `npx vitest run test/proxyCameraCalls.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; the fake's status route answers from `fake.cameraStatus` (a Map per camera, default online with the sim-like streams `{main: h265 3840x2160 20, sub: h264 640x360 15}`, credentials `{source: 'store', authOk: true}`, tls `{mode: 'none', served: null, problem: null}`), 401 for a wrong token.
- [ ] **Step 4: Run** `npx vitest run test/proxyCameraCalls.test.ts test/clipNames.test.ts test/proxyClient.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/proxy/cameraCalls.ts server/proxy/client.ts server/recordings/clipNames.ts test/proxy/fakeProxy.ts test/proxyCameraCalls.test.ts
git commit -m "feat: read camera status and time from the proxy"
```

---

### Task 3: Reads through the proxy (status, device, snapshot, settings, light)

**Files:**
- Modify: `server/routes/cameras.ts` (`/status`, `/snapshot.jpg`), `server/routes/settings.ts` (`GET /settings`, `GET /device`, `GET /light`), `test/proxy/fakeProxy.ts` (`/snapshot.jpg`, `GET /settings`, `GET /light`), `web/src/lib/liveUi.ts` (`offlineReason` codes)
- Test: `test/throughProxyReads.test.ts`

**Interfaces:**
- Consumes: `throughProxy` (Task 1), `readProxyStatus`, `proxyPath`, `getProxyClient` (Task 2).
- Produces: for a through-proxy camera, `GET /api/cameras/:id/status` answers
  - online: `{ id, online: true, model, firmware, simulator, streams, via: 'proxy' }`;
  - offline: `{ id, online: false, error, offlineSince, via: 'proxy', fix: { login: 'missing' | 'refused' | null, trust: { fingerprint: string } | null, canFix: boolean } }` with `error` the first that applies: proxy unreachable or refused → `proxy_unreachable`; `credentials.source === 'none'` → `camera_credentials_missing`; `credentials.authOk === false` → `camera_auth_failed`; `tls.problem` `untrusted` → `camera_untrusted`, `changed` → `camera_cert_changed`; else `camera_offline`. `fix.trust.fingerprint` is the proxy's `tls.served` (null when it has none: no trust button). `canFix`: the camera's proxy has an `adminToken`. Direct cameras answer exactly as today (no `via`).
- Produces: `GET /api/cameras/:id/device` from the proxy status: `{ model, firmware, hardware, name, storage: {totalMb: capacityMB, usedMb: capacityMB − freeMB, mounted} | null, certificate: {subject, issuer, validTo, daysLeft} | null, ...webUiOf(cam) }`; `/snapshot.jpg` streams the proxy's `/snapshot.jpg?stream=main`; `GET /settings` the proxy's `{detection, image}`; `GET /light` its `{on}`. Proxy failures: 502 `proxy_unavailable` (`proxyFailed`), the proxy's 503 `camera_offline` as 503 `camera_offline`.
- `offlineReason` gains: `proxy_unreachable` "The camera's cam-proxy could not be reached.", `camera_untrusted` "The cam-proxy doesn't trust the camera's certificate yet.", `camera_cert_changed` "The camera now shows another certificate than the one trusted."

- [ ] **Step 1: Write the failing tests** (`test/throughProxyReads.test.ts`, a fleet with one through-proxy camera on the fake proxy and a cam-sim at its host): each route answers from the fake (shapes above); each `fix`/`error` case from a fake status; `GET /device` maps storage and `daysLeft`; the cam-sim saw no login (`loginAttempts` 0) after all of them.
- [ ] **Step 2: Run** `npx vitest run test/throughProxyReads.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the branches at the top of each route (`if (throughProxy(id)) return viaProxy…`), the fake routes, the reason texts.
- [ ] **Step 4: Run** `npx vitest run test/throughProxyReads.test.ts test/cameraRoutes.test.ts test/settingsRoutes.test.ts test/lightRoutes.test.ts web/src/lib` — Expected: PASS (direct-camera tests unchanged).
- [ ] **Step 5: Commit**

```bash
git add server/routes/cameras.ts server/routes/settings.ts test/proxy/fakeProxy.ts web/src/lib/liveUi.ts test/throughProxyReads.test.ts
git commit -m "feat: camera reads through the proxy for proxied cameras"
```

---

### Task 4: Camera-changing calls with the proxy-admin token

**Files:**
- Modify: `server/routes/settings.ts` (`PUT /settings/:section`, `PUT /light`, `POST /reboot`), `server/routes/name.ts`, `test/proxy/fakeProxy.ts` (`PUT /settings/:section`, `PUT /light`, `POST /reboot`, `PUT /control/cameras/:cam/name`; admin token required on each)
- Test: `test/throughProxyWrites.test.ts`

**Interfaces:**
- Consumes: `proxyAdminClient` (Task 2).
- Produces (through-proxy cameras only):
  - `PUT /api/cameras/:id/settings/:section`: the body to the proxy as is; its 200/207 `{fields, settings}` relayed; its 400 `{error: 'invalid', details}` answered as `{error: 'bad_request', details}`; 404 for another section (checked here first).
  - `PUT /api/cameras/:id/light`: body checked here as today, relayed; 200 `{on}`, 502 `{error: 'not_applied', on}` relayed.
  - `POST /api/cameras/:id/reboot`: body `{confirm: 'reboot'}` checked here; proxy 202 `{confirmed: true}` → 200 `{ok: true}`, `{confirmed: false}` → 202 `{ok: true, confirmed: false}`, 429 → 429 `{error: 'reboot_cooldown'}`. cams's own cooldown map is not used for them (the proxy's counts).
  - `PUT /api/cameras/:id/name`: `PUT /control/cameras/<proxyCameraId>/name` (not the legacy `/control/camera/name`), no direct fallback; answers as `viaProxy` maps today. A non-through camera keeps today's paths.
  - No `adminToken`: 403 `{error: 'proxy_admin_missing'}` on all four.
  - Logs as today (`camera_light_switched`, `camera_reboot_requested`, `camera_renamed` with `via: 'proxy'`).

- [ ] **Step 1: Write the failing tests**: each call reaches the fake with the admin token (not the client token) and maps as above; without `adminToken` 403 `proxy_admin_missing` and the fake saw nothing; a two-camera fake proxy renames the second camera by its proxy id; cam-sim `loginAttempts` 0.
- [ ] **Step 2: Run** `npx vitest run test/throughProxyWrites.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the branches and the fake routes.
- [ ] **Step 4: Run** `npx vitest run test/throughProxyWrites.test.ts test/cameraNameRoutes.test.ts test/settingsRoutes.test.ts test/lightRoutes.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/routes/settings.ts server/routes/name.ts test/proxy/fakeProxy.ts test/throughProxyWrites.test.ts
git commit -m "feat: camera settings, light, reboot and name through the proxy-admin token"
```

---

### Task 5: Recordings and compositions without camera fallbacks

**Files:**
- Modify: `server/recordings/service.ts` (`client()` callers at `:253`, `:263`, `:292`, `:303`, `:319`, `:404`, `:409`, `:536`, `:614`, `:831`), `server/routes/compose.ts` (`:150-155`)
- Test: `test/recordingsThroughProxy.test.ts`

**Interfaces:**
- Consumes: `throughProxy`, `proxyTimeInfo`.
- Produces: `RecordingsService.cameraTime(id: CamKey): Promise<TimeInfo>` — `proxyTimeInfo` for a through-proxy camera, else the camera client's `timeInfo()`; every former `this.client(id).timeInfo()` and the compose route use it.
- Produces: for a through-proxy camera, `listViaProxy` returning null (proxy unreachable) throws `RecordingError('recordings_unavailable', …)` instead of Search; the camera's own download (step 3 in both download paths) is skipped and the proxy's error is final; `cameraPath` is never reached. Day lists from the proxy are not marked `doubtful`.

- [ ] **Step 1: Write the failing tests**: a through-proxy camera's day and month lists, a clip fetch and a download come from the fake; with the fake answering 502 they fail with `recordings_unavailable` and cam-sim saw no Search, Download or login; `invalidateAround` and a composition use the proxy's time (fake `time` with a DST rule → the expected offset).
- [ ] **Step 2: Run** `npx vitest run test/recordingsThroughProxy.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `cameraTime` and the three guards.
- [ ] **Step 4: Run** `npx vitest run test/recordingsThroughProxy.test.ts test/recordingsViaProxy*.test.ts test/recordingsService.test.ts test/composeRoutes.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/recordings/service.ts server/routes/compose.ts test/recordingsThroughProxy.test.ts
git commit -m "feat: recordings and compositions without camera fallbacks for proxied cameras"
```

---

### Task 6: Live relay (proxy WebSocket to chunked HTTP)

**Files:**
- Create: `server/proxy/live.ts`, `test/liveThroughProxy.test.ts`, `test/proxy/fakeLive.ts`
- Modify: `server/routes/cameras.ts` (`/live`), `test/proxy/fakeProxy.ts` (WebSocket on its server), `package.json` (devDependencies `ws`, `@types/ws`)

**Interfaces:**
- Produces (`server/proxy/live.ts`):
  - `export const LIVE_CODECS = /^[A-Za-z0-9.,]{1,512}$/`
  - `export const MSE_MIME = /^video\/mp4; codecs="[A-Za-z0-9.,]{1,512}"$/`
  - `export interface ProxyLive { mime: string; chunks: AsyncIterable<Uint8Array>; close(): void }`
  - `export function openProxyLive(id: CamKey, quality: 'sub' | 'main', codecs: string | undefined, signal: AbortSignal): Promise<ProxyLive>` — undici `WebSocket` to `wss|ws://<proxy>/api/cameras/<proxyCameraId>/live?stream=<quality>[&codecs=…]` with `headers: { Authorization: 'Bearer <client token>' }` and, for a pinned proxy, `dispatcher: await groupDispatcher(g)`; the token goes only to a confirmed endpoint (`secretAllowed`, as `ProxyClient.open`). Resolves on the first `{"type":"mse"}` text whose value matches `MSE_MIME` (10 s, else rejects `ProxyError('proxy_error')`); a `{"type":"error"}` text (the proxy's `camera_offline`, `camera_restarting`, `stream_unavailable`, `too_many_streams`) or a close before it rejects `ProxyError('proxy_error', …, 503, <value>)`; a failed upgrade (refused token, proxy down) rejects `proxy_unreachable`.
  - `test/proxy/fakeLive.ts`: `fmp4Stream(o: { signal: AbortSignal }): AsyncIterable<Buffer>` — `ffmpeg -re -f lavfi -i testsrc2=size=640x360:rate=15 -c:v libx264 -profile:v high -level 4.1 -g 15 -an -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1`, and the MIME `video/mp4; codecs="avc1.640029"`.
- Produces (route): for a through-proxy camera, `GET /api/cameras/:id/live?quality=sub|main[&codecs=…]` (codecs checked against `LIVE_CODECS`, else 400 `invalid`): same `MAX_LIVE_PER_CAMERA` slot, `Content-Type: <mime>`, `X-Accel-Buffering: no`, each chunk written as it arrives; `res.writableLength > 4 MiB` → the response is destroyed and the socket closed (`camera_stream_failed` with `code: 'slow_viewer'`); a proxy close ends the response; a viewer close closes the socket. Before the first chunk: the proxy's error values → 503 `{error: <value>}`; unreachable → 502 `proxy_unavailable`. Direct cameras: unchanged (FLV).
- Fake: `WebSocketServer({ noServer: true })` on `/api/cameras/:cam/live`; bearer check (401 before upgrade); `fake.liveRefusal` (an error value sent as `{"type":"error"}` and close 1013 instead of the stream); on connect the `mse` text then `fmp4Stream` chunks as binary; `fake.liveOpen` counts open sockets.

- [ ] **Step 1: Write the failing tests** (`test/liveThroughProxy.test.ts`):

```ts
it('relays fMP4 with the proxy\'s MIME type', async () => { /* GET live → 200, content-type 'video/mp4; codecs="avc1.640029"', first bytes contain 'ftyp', more data within 3 s */ });
it('passes quality and codecs on and refuses bad codecs', async () => { /* fake saw stream=main&codecs=avc1.64002A; codecs='a"b' → 400 */ });
it('closes the proxy socket when the viewer leaves and frees the slot', async () => { /* abort → fake.liveOpen back to 0; liveStreamCount 0 */ });
it('ends the response when the proxy closes', async () => {});
it('cuts a viewer that stops reading', async () => { /* paused reader → response destroyed, fake socket closed */ });
it('answers 503 camera_offline when the proxy sends that error, before any byte', async () => {});
it('never sends the token to an unconfirmed endpoint', async () => { /* secret guard on, endpoint not bound → 502, fake saw no upgrade */ });
```

- [ ] **Step 2: Run** `npx vitest run test/liveThroughProxy.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `live.ts`, the route branch, the fake WebSocket; `npm install -D ws @types/ws`.
- [ ] **Step 4: Run** `npx vitest run test/liveThroughProxy.test.ts test/cameraRoutes.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/proxy/live.ts server/routes/cameras.ts test/proxy/fakeProxy.ts test/proxy/fakeLive.ts test/liveThroughProxy.test.ts package.json package-lock.json
git commit -m "feat: live video of proxied cameras relayed from the proxy's WebSocket"
```

---

### Task 7: The browser's fMP4 player

**Files:**
- Create: `web/src/lib/fmp4Player.ts`, `web/src/lib/fmp4Player.test.ts`
- Modify: `web/src/lib/live.ts` (`liveUrl`, `browserCodecs`), `web/src/components/LivePlayer.svelte` (player choice), `web/src/lib/stores.ts` (the camera type's `throughProxy`), `web/src/components/LivePlayer.svelte.test.ts`

**Interfaces:**
- Consumes: `Player`, `PlayerFactory` (`web/src/lib/liveSession.ts`); `CameraSummary.throughProxy` (Task 1); the route's `Content-Type` (Task 6).
- Produces:
  - `export const CODEC_CANDIDATES = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2']`
  - `export function browserCodecs(isTypeSupported: (t: string) => boolean): string` — the candidates for which `isTypeSupported('video/mp4; codecs="<c>"')`, comma-joined.
  - `liveUrl(cameraId: string, quality: Quality, codecs?: string): string` — adds `&codecs=<encoded>` when given.
  - `export function fmp4Player(url: string): Player` — `attach(video)`: a `ManagedMediaSource` where it exists, else `MediaSource`, as `video.src`; `load()`: `fetch(url)` with an `AbortController`, the `Content-Type` as the SourceBuffer type (`mode = 'segments'`), chunks appended in order through a queue (one `appendBuffer` at a time, on `updateend`); keeps latency: when `buffered.end − currentTime > 1.5 s`, `currentTime = end − 0.3`; removes what is more than 30 s behind `currentTime`; `onFailure` fires once on a fetch error, a non-200, the body ending, a SourceBuffer `error`, a `QuotaExceededError`, or a type `isTypeSupported` refuses; `destroy()` aborts the fetch and detaches the source.
  - `LivePlayer.svelte`: `fmp4Player` and `liveUrl(id, quality, browserCodecs(MediaSource.isTypeSupported))` when the camera's `throughProxy`, else `mpegtsPlayer` as today.

- [ ] **Step 1: Write the failing tests** (`web/src/lib/fmp4Player.test.ts`, a fake `MediaSource`/`SourceBuffer` and a `ReadableStream` body): appends chunks in order one at a time; uses the response's Content-Type; fails once on body end, on a 503, on a SourceBuffer error; jumps ahead past 1.5 s latency; destroy aborts the fetch. `browserCodecs` and `liveUrl` cases. LivePlayer test: a through-proxy camera uses the fmp4 factory with `codecs` in the URL.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/fmp4Player.test.ts web/src/components/LivePlayer.svelte.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add web/src/lib/fmp4Player.ts web/src/lib/fmp4Player.test.ts web/src/lib/live.ts web/src/components/LivePlayer.svelte web/src/components/LivePlayer.svelte.test.ts web/src/lib/stores.ts
git commit -m "feat: fMP4 live player for cameras behind a proxy"
```

---

### Task 8: Camera login and certificate trust relayed to the proxy

**Files:**
- Create: `web/src/components/CameraTrust.svelte`, `web/src/components/CameraTrust.svelte.test.ts`, `web/src/components/OfflineFix.svelte`, `web/src/components/OfflineFix.svelte.test.ts`, `test/throughProxyLogin.test.ts`
- Modify: `server/routes/accounts.ts` (`PUT /api/cameras/:id/credentials`), `server/routes/cameras.ts` (`POST /api/cameras/:id/trust`), `server/routes/access.ts`, `web/src/components/CameraLogin.svelte`, `web/src/components/LiveBox.svelte`, `web/src/components/CameraCard.svelte`, `web/src/pages/Settings.svelte` (passes `throughProxy` to `CameraLogin`), `test/proxy/fakeProxy.ts` (`PUT /control/cameras/:cam/password`, `POST /control/cameras/:cam/actions/camera-trust-pin`)

**Interfaces:**
- Consumes: `proxyAdminClient`, `readProxyStatus` (Task 2); `fix` in the status (Task 3).
- Produces (server, through-proxy cameras, any config mode):
  - `PUT /api/cameras/:id/credentials` `{password}` (checked as today: 1–128 characters, no control characters) → proxy `PUT /control/cameras/<proxyCameraId>/password` `{password}` with the admin token, 20 s timeout. Answers: 204 (saved; nothing stored here; `resetClients` not needed); 422 `camera_refused`; 503 `camera_offline`; 409 `env_password`; 429 `too_many_attempts` with the proxy's `Retry-After`; 403 `proxy_admin_missing`; 502 `proxy_unavailable`. Logs `camera_password_relayed` `{cameraId, outcome, by}`. A non-through camera keeps today's behaviour (local file, `file_mode` 409).
  - `POST /api/cameras/:id/trust` `{fingerprint}` (admin; a line in `access.ts`): `fingerprint` must be `SHA256:` + base64 or hex as cam-proxy prints it (else 400); cams re-reads `readProxyStatus` and refuses 409 `{error: 'fingerprint_changed', fingerprint: <served now>}` when `tls.served` differs; then proxy `POST /control/cameras/<proxyCameraId>/actions/camera-trust-pin` `{fingerprint}`; 200 `{mode: 'pinned'}`; the proxy's 409 `fingerprint_mismatch` → the same 409 `fingerprint_changed` with its `served`; 403 `proxy_admin_missing`; 404 `not_through_proxy` for a direct camera. Logs `camera_trust_relayed` `{cameraId, outcome, by}`.
- Produces (web):
  - `CameraLogin.svelte` for a through-proxy camera: shown to admins in both config modes; the line "Save the login for {camera name} on its cam-proxy?", the password field and Save; the answer in words (saved / "The camera refused this password." / "The camera can't be reached." / "Too many tries; wait {s} s." / "This proxy has a password in its settings file; remove it there first." / "cams has no admin token for this proxy: use the proxy's admin page."). No Secret instructions.
  - `CameraTrust.svelte` `{cameraId, fingerprint}`: "Trust this camera's certificate? The cam-proxy measured: {fingerprint}" with Trust; on 409 shows the new fingerprint for another confirm.
  - `OfflineFix.svelte` `{cameraId, fix}` in the offline box (`LiveBox`) and `CameraCard`: "Enter password" (`data-testid="offline-password"`) when `fix.login`, "Trust certificate" (`data-testid="offline-trust"`) when `fix.trust`; both disabled with the admin-page hint when `!fix.canFix`; hidden for viewers. Saving re-checks the live status.

- [ ] **Step 1: Write the failing server tests** (`test/throughProxyLogin.test.ts`): each relay answer; the password reaches the fake only with the admin token and never appears in a log line (`logger` capture) or in the credentials file (file unchanged); trust with a stale fingerprint → 409 and no pin sent; trust for a direct camera → 404.
- [ ] **Step 2: Write the failing component tests**: `OfflineFix` shows the right buttons per `fix`, disabled without `canFix`, hidden for viewers; `CameraLogin` through-proxy wording and each answer text; `CameraTrust` shows the fingerprint and handles 409.
- [ ] **Step 3: Run** `npx vitest run test/throughProxyLogin.test.ts web/src/components/OfflineFix.svelte.test.ts web/src/components/CameraTrust.svelte.test.ts web/src/components/CameraLogin` — Expected: FAIL.
- [ ] **Step 4: Implement** routes, access line, fake routes (the fake records the bodies' presence, never the password value, and answers per `fake.passwordAnswer` / `fake.trustAnswer`), components.
- [ ] **Step 5: Run** the same plus `npx vitest run test/access.test.ts test/accountsRoutes.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add server/routes/accounts.ts server/routes/cameras.ts server/routes/access.ts web/src/components/CameraLogin.svelte web/src/components/CameraTrust.svelte web/src/components/CameraTrust.svelte.test.ts web/src/components/OfflineFix.svelte web/src/components/OfflineFix.svelte.test.ts web/src/components/LiveBox.svelte web/src/components/CameraCard.svelte web/src/pages/Settings.svelte test/proxy/fakeProxy.ts test/throughProxyLogin.test.ts
git commit -m "feat: camera login and certificate trust relayed to the proxy"
```


---

### Task 9: No camera passwords or camera trust for proxied cameras

**Files:**
- Modify: `server/admin/apply.ts` (`ApplyContext.throughProxy`, `buildFleet`), `server/admin/trust.ts` (`decide`), `server/configSource.ts` (wire `throughProxyAt`), `server/credentials.ts` (`removeCameraPassword`), `server/reolink/clients.ts` (guard), `server/tls/cameraTrust.ts` (`applyProxyTls`), `server/cameraRegistry.ts` (`parseCameras`: `password` optional with a `proxy`), `server/proxy/features.ts` (cleanup on `'through'`)
- Test: `test/admin/throughProxyTrust.test.ts`, `test/credentials.test.ts`, `test/cameraRegistry.test.ts`, `test/fallbackPin.test.ts`

**Interfaces:**
- Consumes: `throughProxyAt`, `featureEvents` (Task 1).
- Produces:
  - `ApplyContext.throughProxy?: (accountId: string, proxyUrl: string) => boolean`. In `buildFleet`, for a camera whose offered proxy URL is through-proxy: `ctx.credentials` is not asked, `password: ''`, `credentials: 'ok'`, no `bind` of a camera password; `ctx.trust(..., move, { viaProxy: p.id })`.
  - `TrustStore.decide(accountId, camsId, offered, move?, via?: { viaProxy: string })`: with `via`, only `PROXY_TRUST_FIELDS` are compared (camera `host`, `protocol`, `tlsServername` are taken from the offer and never held); a camera with nothing confirmed is confirmed when `isTrusted(accountId, via.viaProxy, offered)` and that proxy has no held offer (log entry `action: 'via-proxy'`, `logger.info` `camera_trusted_via_proxy`); otherwise as today.
  - `removeCameraPassword(accountId: string, camsId: string): Promise<boolean>` (atomic like `setCameraPassword`; false when absent or not writable). On `'through'` (on) and at start for every through-proxy camera with an entry: removed when writable (`camera_password_removed` `{cameraId}`), else logged once `camera_password_left` `{cameraId, reason: 'read_only'}`.
  - `requireClient`/`getClient`: a through-proxy camera throws `CameraError('camera_offline', 'reached through its proxy only')` and logs `direct_call_refused` once (a missed branch shows up, never a call).
  - `applyProxyTls`: a through-proxy camera clears its fallback pin and returns.
  - `parseCameras`: `password` may be absent or empty for an entry with `proxy` (file mode, cams-only setups).

- [ ] **Step 1: Write the failing tests**: a through-proxy camera with changed `host` is not held and uses the offered host; a new camera on a trusted proxy is confirmed (`via-proxy` in the log); a new camera on a held or untrusted proxy is still held as new; a direct camera's holds are unchanged; `removeCameraPassword` keeps the other entries and mode 600; the cleanup runs on `'through'` and at start, and only logs for a read-only file; `requireClient` refuses a through-proxy camera; a `cameras.json` entry with `proxy` and no password loads.
- [ ] **Step 2: Run** `npx vitest run test/admin/throughProxyTrust.test.ts test/credentials.test.ts test/cameraRegistry.test.ts test/fallbackPin.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/admin test/credentials.test.ts test/cameraRegistry.test.ts test/fallbackPin.test.ts test/cameraTrust.test.ts test/heldRoutes.test.ts test/noUnverifiedTls.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/admin/apply.ts server/admin/trust.ts server/configSource.ts server/credentials.ts server/reolink/clients.ts server/tls/cameraTrust.ts server/cameraRegistry.ts server/proxy/features.ts test/admin/throughProxyTrust.test.ts test/credentials.test.ts test/cameraRegistry.test.ts test/fallbackPin.test.ts
git commit -m "feat: no camera passwords or camera trust for cameras behind a proxy"
```

---

### Task 10: No direct call for a proxied camera (guard test)

**Files:**
- Create: `test/noDirectCallsThroughProxy.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the test**: a fleet with one through-proxy camera whose `host` is a running cam-sim (with a valid password in the config, so a direct call would succeed); call every camera route (`/status`, `/device`, `/snapshot.jpg`, `/live` (read 1 chunk, abort), `/settings` GET/PUT, `/light` GET/PUT, `/reboot`, `/name`, `/credentials`, `/trust`, recordings days/day/clip/download, a composition) and the MCP `list_cameras` tool; then stop the fake proxy and call them again. Assert cam-sim's `loginAttempts`, Search and Download counters stay 0, and with the proxy stopped `/status` answers `{online: false, error: 'proxy_unreachable'}`.
- [ ] **Step 2: Run** `npx vitest run test/noDirectCallsThroughProxy.test.ts` — Expected: PASS (it guards Tasks 3–9; a FAIL names the route that still calls the camera: fix it in that route).
- [ ] **Step 3: Commit**

```bash
git add test/noDirectCallsThroughProxy.test.ts
git commit -m "test: no direct camera call for a camera behind a proxy"
```

---

### Task 11: e2e, real proxy, docs

**Files:**
- Create: `e2e/through-proxy.spec.ts`
- Modify: `e2e/cameras.json` (camera `mill`: `host: "from-proxy"`, no password, proxy `http://127.0.0.1:8079` with an `adminToken`), `playwright.config.ts` (a second fake proxy: `FAKE_PROXY_PORT=8079 FAKE_PROXY_FEATURES=sse-cam-list,ptz,camera-calls npx tsx test/proxy/fakeProxy.ts`, port 8079, its hooks on 8077; 8093 is the first fake's hooks port), `e2e/fakeProxyData.ts` (seed `mill`), `e2e/env.ts` (`CAM_PROXY_TAG`, `CAM_PROXY_DIGEST` of the camera-calls release), `e2e/realProxy.spec.ts`, `test/e2eEnv.test.ts`, `CLAUDE.md`, `docs/livestack.md`, `CHANGELOG.md`, `docs/through-proxy-kube-setup.md`

**Interfaces:**
- Consumes: the fake's `liveRefusal`, `cameraStatus`, `passwordAnswer`, `trustAnswer` (Tasks 2–8), set from the spec through new hook routes beside `/push` (`POST /camera-status`, `POST /password-answer`, `POST /trust-answer`, `POST /live-refusal`; hooks port = proxy port − 2).

- [ ] **Step 1: Write the e2e spec** (`e2e/through-proxy.spec.ts`, desktop and phone): `mill` plays live (`[data-testid=live-video]` `currentTime` grows past 1 s); the Settings page reads and saves an image setting (the fake saw the admin token); with the fake's status offline + `credentials.authOk: false`, the offline box shows `offline-password`, the dialog saves (fake `passwordAnswer` 200) and the box clears; with `tls.problem: 'untrusted'` and a `served` fingerprint, `offline-trust` shows that fingerprint and Trust pins it.
- [ ] **Step 2: Extend the real-proxy spec**: Silo (real cam-proxy with `camera-calls`) plays live through the proxy (response `content-type` starts with `video/mp4`), and its status answers `via: 'proxy'`.
- [ ] **Step 3: Run** `npm run build && npx playwright test e2e/through-proxy.spec.ts` — Expected: PASS (the real-proxy spec runs in CI only).
- [ ] **Step 4: Docs.** `CLAUDE.md`: the recordings rule gains "a camera whose proxy lists `camera-calls` has no camera fallback at all; `server/reolink/*` is for cameras without one". `docs/livestack.md`: the through-proxy check (live `video/mp4`, no camera login from cams). `CHANGELOG.md` `## [Unreleased]`: "Cameras behind an up-to-date cam-proxy are reached only through it: live video, status, settings, light, reboot and the camera login go through the proxy, and cams keeps no camera password for them." `docs/through-proxy-kube-setup.md`: the kube-setup request from Prerequisites (which Secret keys, after which check), for the Cluster session.
- [ ] **Step 5: Full run**

Run: `npm run build && npm run lint:types && npm run check && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add e2e/through-proxy.spec.ts e2e/cameras.json playwright.config.ts e2e/fakeProxyData.ts e2e/env.ts e2e/realProxy.spec.ts test/e2eEnv.test.ts CLAUDE.md docs/livestack.md CHANGELOG.md docs/through-proxy-kube-setup.md
git commit -m "test: e2e for cameras through the proxy; docs and the kube-setup request"
```

After the PR merges and deploys: run the livestack (cam-sim; the real-camera part with Klaus's OK), post the release and the kube-setup request (Secret cleanup) to #cams-application and to the Cluster session.

## Decisions beyond the spec

- **The browser player changes for proxied cameras.** cams's player today is mpegts.js over FLV (`web/src/lib/mpegtsPlayer.ts`), which plays no fMP4; go2rtc's MSE WebSocket gives fMP4. So proxied cameras get an MSE fMP4 player (`fmp4Player`) behind the same `Player` interface; the route stays chunked HTTP (§10.3). Direct cameras keep FLV.
- **The browser names the codecs it can play** (`codecs=` on the live URL, passed to the proxy and on to go2rtc), so main H.265 is offered only where the browser decodes it (today's `supportsHevc` rule).
- **Features are persisted per account and proxy URL** (no token, no URL in the file), so a restart while the proxy is down still shows "proxy unreachable" instead of falling back.
- **The Settings "use cam-proxy" switch is locked on** for a through-proxy camera (409 `proxy_required`): off would leave a camera with no password and no path.
- **Camera trust for proxied cameras:** camera host/protocol/TLS-name changes are not held, and a new camera on a proxy this viewer already trusts is confirmed without a click (the only secret it gets is that proxy's token, already trusted). New or changed proxies are still held as today.
- **Trust dialog fingerprint** comes from the proxy's status (`tls.served`), re-read before pinning; a stale one answers 409 `fingerprint_changed`.
- **`cameras.json` passwords become optional** for entries with a proxy (cams-only and livestack setups).
- **Renaming through a proxy uses `/control/cameras/:cam/name`** (the legacy `/control/camera/name` named the proxy's one camera, wrong on multi-camera hosts).
- **Read-only credentials files are not touched**: leftover entries are logged (`camera_password_left`) and handed to kube-setup.
