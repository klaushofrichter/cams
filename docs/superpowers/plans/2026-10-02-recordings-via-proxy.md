# Recordings via cam-proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For a camera with a cam-proxy, History's day list, the month's days, playback, the clip download and the clip-based thumbnails come from cam-proxy's recordings API (SD-card files fetched over Baichuan), with the proxy's FTP copies and then the camera's own HTTP download as fallbacks; cameras without a proxy are unchanged.

**Architecture:** A new client module, `server/recordings/proxyRecordings.ts`, talks to the proxy's three recordings routes through the existing `ProxyClient`. `RecordingsService` (`server/recordings/service.ts`) wraps every proxy call in one helper, `viaProxy()`. It returns `null` for "use the next route" (502/503, an unreachable proxy and similar failures, all logged as `proxy_recordings_failed`), throws for a gone recording (`unknown_clip`) or an abort, and records the outcome for `downloadsState()` (`proxy-recordings` or `proxy`). `day()`, `days()`, `withClip()` and `openDownload()` put the proxy first and keep today's code as the fallback. Proxy requests stay outside the camera's transfer slot.

**Tech Stack:** Node 26, TypeScript 7, Express 5, Svelte 5 (runes), Vitest (projects `node` and `components`), Playwright, cam-sim (release tarball), the fake cam-proxy in `test/proxy/fakeProxy.ts`, and Docker for the last task's real cam-proxy.

**Spec:** `docs/superpowers/specs/2026-10-02-recordings-via-proxy-design.md` (cams). The API it consumes is in cam-proxy's `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`, section 2, "The recordings API" (`git -C ~/Development/cam-proxy show origin/docs/baichuan-spec:docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`). Read both before Task 1.

## Global Constraints

- Cameras without a cam-proxy, or with it switched off on Settings (`proxyActive()` false), are unchanged: the camera's Search, its HTTP download, the breaker. Tests prove it (Tasks 3, 4, 5).
- For a proxied camera, **every** camera Search goes through the proxy: the day list (`GET /recordings?from&to&stream`, sub then main, one after the other) and the month list (`GET /recordings/days?month=YYYY-MM`). cams runs its own Search only when the proxy can't answer.
- Route order: playback and clip thumbnails (`withClip()`, sub) go to the proxy's recordings, then the proxy's FTP copy (`findProxyClip()`/`openProxyClip()`), then the camera's HTTP download behind the breaker (`downloadWithRetry()` in the transfer gate). A sub download (`openDownload()`) uses the same order. A **main (4K) download** never falls back to the FTP copy (it is the sub stream; Klaus, 2026-10-02: no silent quality downgrade). It goes to the proxy's recordings, then the camera; if both fail, `503 full_quality_unavailable`, and the Save dialog says "The full-resolution file isn't available right now; download the standard quality instead" and offers SD.
- Fallback triggers: proxy 502, 503, unreachable, and 400 (a bug in cams, logged at error). Also, beyond the spec's list, a refused token (401/403) and a plain 404 from an older cam-proxy without the API. **Final:** 404 `{"error":"unknown_recording"}` becomes `RecordingError('unknown_clip')` with no fallback. A client abort is never retried on another route.
- Filenames: from the recordings API `<cam>-<date>_<HH-MM-SS>-sub.mp4` / `-main.mp4` (the camera's file); from an FTP copy `-proxy.mp4`, as today.
- A failure mid-stream in `openDownload()` ends the response short, with no fallback once bytes were sent.
- Thumbnails for a proxied camera: the proxy's still 2 s into the event first (`findProxyStill()`, unchanged); only when that fails is the thumbnail made from the clip (`clipThumbnail()` → `withClip()`).
- Proxy requests stay outside cams' camera transfer slot; the camera's HTTP fallback still takes it. The breaker counts camera refusals only; proxy failures never open it.
- `from`/`to` of the day list are the camera-local day's bounds in unix ms, from the camera's `timeInfo()`.
- `downloadsState`: `proxy-recordings` (proxy, last recordings request didn't fail), `proxy` (proxy, last recordings request failed), `ok`/`unavailable` (no proxy, as today). The note reads "cam-proxy (SD card)", "cam-proxy (FTP copies)" or "camera".
- Logging: `proxy_recordings_failed` at warn (400 at error) with the camera, the clip id (or the day or month), and the error code. Never a token, password or cookie.
- Timeouts for a recording file: those of `openProxyClip()` (30 s to the headers, 30 s idle).
- Keep the fake proxy (`test/proxy/fakeProxy.ts`) in step with cam-proxy's client API (CLAUDE.md).
- Repo rules: stage files explicitly; CHANGELOG entries under `## [Unreleased]`; no version in the sources; no committed media (test videos come from ffmpeg at run time); every new UI element used by e2e has a `data-testid`; don't run Playwright on the self-hosted runner.
- Work on a branch `feat/recordings-via-proxy` from `main` (after `docs/baichuan-spec` is merged), with a PR to `main`. Merge only when all checks pass.

## Review Focus

1. **An older cam-proxy without the recordings API.** It answers `/recordings` with a plain 404 (`not_found`, or Express's HTML). Expected: cams falls back to the camera's Search and the FTP copy; it never answers `unknown_clip`. Pinned in Task 2 (`fallsBack` on a plain 404) and Task 3 (day list on a plain 404).
2. **A list from the proxy, then the proxy fails for the file.** The day list then holds bare file names, but the camera's Download needs the full `/mnt/sda/...` path. Expected: cams finds the folder with the camera's own Search (allowed, since the proxy just failed) and plays or downloads from the camera. Pinned in Task 4 ("then the camera, finding the file's folder") and Task 5 ("on 503 without one, the camera").
3. **A camera-local day on a DST change, or east of UTC.** Expected: `from`/`to` cover the whole local day whichever offset applies, so a 00:10 recording isn't lost. Pinned in Task 3 (`dayBounds` for Chicago on the fall-back day, Berlin on the spring-forward day, UTC).
4. **Bad data from the proxy.** A path-like or malformed id (`../../etc/passwd.mp4`), a list that isn't a list, days out of range or not integers. Expected: dropped or treated as a proxy failure, never used in a URL or a path. Pinned in Task 2.
5. **A transfer that drops midway.** Expected: playback falls back to the FTP copy (nothing was sent yet, the file goes to cams' cache first), while a download ends short with no fallback. Pinned in Task 4 (drop → FTP copy) and Task 5 (drop → short response).

---

## File Structure

**Create**
- `server/recordings/errors.ts`: `RecordingError`, moved out of `service.ts`, so `proxyRecordings.ts` can throw it without a circular import.
- `server/recordings/proxyRecordings.ts`: the client for the proxy's recordings API (`listProxyRecordings`, `listProxyDays`, `openProxyRecording`), the fallback rule (`fallsBack`) and the log line (`logProxyFailure`).
- `test/fakeProxyRecordings.test.ts`: the fake's recordings routes against cam-proxy's shapes.
- `test/proxyRecordings.test.ts`: the client module.
- `test/proxy/seedRecordings.ts`: test helper. It gives the fake proxy the SD recordings cam-sim holds for a day, as the real proxy would list them.
- `test/recordingsViaProxy.test.ts`: the day list, the month list, `downloadsState`, and unchanged cameras.
- `test/recordingsViaProxyClips.test.ts`: playback and thumbnails.
- `test/recordingsViaProxyDownloads.test.ts`: the clip download.
- `e2e/realProxy.ts`: starts the released cam-proxy container for Silo (Task 7).
- `e2e/realProxy.spec.ts`: the cross-stack e2e (Task 7).

**Modify**
- `test/proxy/fakeProxy.ts`: the three recordings routes and their test switches.
- `e2e/fakeProxyData.ts`: a comment (the e2e fake holds no SD recordings).
- `server/proxy/client.ts`: export `errorCode()`; `open()` accepts `HEAD`.
- `server/routes/recordings.ts`: `GET /api/cameras/:id/clips/:clipId/full-quality`.
- `web/src/lib/compose.ts`, `web/src/components/ComposeDialog.svelte` (+ test): the 4K-unavailable message.
- `server/recordings/service.ts`: `RecordingError` re-export, `viaProxy()`, `dayBounds()`, `day()`, `days()`, `downloadsState()`, `cameraPath()`, `withClip()`, `openDownload()` (with `handOver()`); `proxyClipFor()` goes.
- `test/camera/sim.ts`: `searches` counter.
- `test/proxySwitch.test.ts`, `test/proxyClips.test.ts`: two expectations that change by design.
- `web/src/lib/dayCache.ts`, `web/src/lib/dayCache.test.ts`, `web/src/pages/Video.svelte`: the new state and the note.
- `e2e/recordings.spec.ts`: the note's new text for Den.
- `docs/reolink-api.md`, `README.md`, `CHANGELOG.md`.
- Task 7: `package.json`/`package-lock.json` (cam-sim release with Baichuan), `e2e/sims.ts`, `e2e/env.ts`, `e2e/cameras.json`, `playwright.config.ts`, `e2e/shell.spec.ts`.

`extent.ts` needs no change: it reads through `days()` and `events()`, so it follows.

---

### Task 1: The fake cam-proxy's recordings routes

**Files:**
- Modify: `test/proxy/fakeProxy.ts` (interface `FakeProxy` at lines 32-61, the object at 76-119, routes before `const server = http.createServer(app)` at line 296)
- Modify: `e2e/fakeProxyData.ts:1-4` (comment only)
- Test: `test/fakeProxyRecordings.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces (in `test/proxy/fakeProxy.ts`):
  - `export interface FakeRecording { id: string; start: number; end: number; stream: 'sub' | 'main'; body: Buffer; kinds?: string[]; clipId?: number | null }`
  - on `FakeProxy`: `recordings: Map<string, FakeRecording[]>` (proxy camera id → its SD recordings; a camera with no entry answers `503 {"error":"camera_offline"}`); `recordingsOverride: { status: number; body: unknown } | null` (every recordings route answers this, after input validation); `recordingDropAfter: number | null` (a GET of a file sends its headers and this many bytes, then drops the connection); `recordingFetches: string[]` (ids of files served by GET, not HEAD).

- [ ] **Step 1: Write the failing test**

Create `test/fakeProxyRecordings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy, type FakeRecording } from './proxy/fakeProxy';

// The fake's recordings routes follow cam-proxy's API (cam-proxy spec
// 2026-10-02-baichuan-recordings-design, section 2), so cams' tests meet the
// shapes and status codes the real proxy sends.
const SUB = 'RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4';
const MAIN = 'RecM0A_DST20261001_211129_211209_0_5514C080000000_66A92E.mp4';
const T0 = 1_790_000_000_000;

let fake: FakeProxy;
const get = (path: string, init: RequestInit = {}) =>
  fetch(`${fake.url}${path}`, { ...init, headers: { Authorization: `Bearer ${FAKE_TOKEN}`, ...(init.headers as Record<string, string> | undefined) } });

beforeEach(async () => {
  fake = await startFakeProxy();
  const rec = (id: string, stream: 'sub' | 'main', body: string): FakeRecording => ({ id, start: T0, end: T0 + 38_000, stream, body: Buffer.from(body) });
  fake.recordings.set('cam1', [rec(MAIN, 'main', 'main-bytes-'.repeat(20)), rec(SUB, 'sub', '0123456789')]);
});
afterEach(() => fake.stop());

describe('fake cam-proxy: recordings', () => {
  it('lists one stream overlapping [from, to], in cam-proxy’s shape', async () => {
    const r = await get(`/api/cameras/cam1/recordings?from=${T0 - 1000}&to=${T0 + 1000}&stream=sub`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([{ id: SUB, start: T0, end: T0 + 38_000, stream: 'sub', size: 10, kinds: [], clipId: null }]);
    expect(await (await get(`/api/cameras/cam1/recordings?from=${T0 + 60_000}&to=${T0 + 70_000}&stream=sub`)).json()).toEqual([]);
  });

  it('refuses a bad window, stream, id or month with 400 invalid', async () => {
    for (const q of ['from=1&to=0&stream=sub', 'from=0&to=1', 'from=0&to=1&stream=hd', `from=0&to=${48 * 3_600_000 + 1}&stream=sub`]) {
      const r = await get(`/api/cameras/cam1/recordings?${q}`);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('invalid');
    }
    expect((await get('/api/cameras/cam1/recordings/not-a-name.mp4')).status).toBe(400);
    expect((await get('/api/cameras/cam1/recordings/days?month=2026-13')).status).toBe(400);
  });

  it('answers 503 camera_offline for a camera it holds no recordings for', async () => {
    for (const p of ['/api/cameras/den/recordings?from=0&to=1&stream=sub', '/api/cameras/den/recordings/days?month=2026-10', `/api/cameras/den/recordings/${SUB}`]) {
      const r = await get(p);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'camera_offline' });
    }
  });

  it('lists the days of a month that have recordings', async () => {
    expect(await (await get('/api/cameras/cam1/recordings/days?month=2026-10')).json()).toEqual({ month: '2026-10', days: [1] });
    expect(await (await get('/api/cameras/cam1/recordings/days?month=2026-09')).json()).toEqual({ month: '2026-09', days: [] });
  });

  it('serves a file with HEAD, Range and 416, and 404 unknown_recording for one it doesn’t have', async () => {
    const head = await get(`/api/cameras/cam1/recordings/${SUB}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(fake.recordingFetches).toEqual([]);
    const whole = await get(`/api/cameras/cam1/recordings/${SUB}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('cache-control')).toBe('private, max-age=604800, immutable');
    expect(Buffer.from(await whole.arrayBuffer()).toString()).toBe('0123456789');
    expect(fake.recordingFetches).toEqual([SUB]);
    const part = await get(`/api/cameras/cam1/recordings/${SUB}`, { headers: { Range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('234');
    const beyond = await get(`/api/cameras/cam1/recordings/${SUB}`, { headers: { Range: 'bytes=50-60' } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */10');
    const gone = await get('/api/cameras/cam1/recordings/RecS0A_DST20261001_000000_000010_0_5514C080000000_1.mp4');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'unknown_recording' });
  });

  it('answers recordingsOverride on every recordings route, and drops a file midway with recordingDropAfter', async () => {
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } };
    expect((await get('/api/cameras/cam1/recordings?from=0&to=1&stream=sub')).status).toBe(502);
    expect((await get('/api/cameras/cam1/recordings/days?month=2026-10')).status).toBe(502);
    expect((await get(`/api/cameras/cam1/recordings/${SUB}`)).status).toBe(502);
    fake.recordingsOverride = null;
    fake.recordingDropAfter = 4;
    const r = await get(`/api/cameras/cam1/recordings/${MAIN}`);
    expect(r.headers.get('content-length')).toBe('220');
    await expect(r.arrayBuffer()).rejects.toThrow();
  });

  it('wants the client token', async () => {
    expect((await fetch(`${fake.url}/api/cameras/cam1/recordings?from=0&to=1&stream=sub`)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project node test/fakeProxyRecordings.test.ts`
Expected: FAIL. `fake.recordings` is undefined (`Cannot read properties of undefined (reading 'set')`).

- [ ] **Step 3: Implement the routes**

In `test/proxy/fakeProxy.ts`, after `export interface FakeAnalysis { … }` (line 30), add:

```ts
// An SD-card recording as cam-proxy's recordings API lists it (cam-proxy spec
// 2026-10-02-baichuan-recordings-design, section 2). `id` is the camera's file
// name without the folder; the listed `size` is the body's length.
export interface FakeRecording { id: string; start: number; end: number; stream: 'sub' | 'main'; body: Buffer; kinds?: string[]; clipId?: number | null }
```

In `interface FakeProxy`, after `knownTypes: string[] | null; …` (line 56), add:

```ts
  recordings: Map<string, FakeRecording[]>; // proxy camera id → its SD recordings; a camera without an entry answers 503 camera_offline
  recordingsOverride: { status: number; body: unknown } | null; // tests: every recordings route answers this (after checking its input)
  recordingDropAfter: number | null; // tests: a file sends its headers and this many bytes, then the connection drops
  recordingFetches: string[]; // ids of the files served by GET (not HEAD)
```

In the `fake` object literal, after `knownTypes: null,` (line 99), add:

```ts
    recordings: new Map(),
    recordingsOverride: null,
    recordingDropAfter: null,
    recordingFetches: [],
```

Directly before `const server = http.createServer(app);` (line 296), add:

```ts
  // SD recordings (cam-proxy spec 2026-10-02-baichuan-recordings-design,
  // section 2). Input is checked first, as the real one does; then the
  // override; then a camera without recordings answers like an offline one.
  const REC_ID = /^Rec[MS][0-9A-Za-z]{2}_(DST)?\d{8}_\d{6}_\d{6}_[0-9A-Za-z_]+\.mp4$/;
  const recordingsOf = (cam: string, res: Response): FakeRecording[] | undefined => {
    if (fake.recordingsOverride) return void res.status(fake.recordingsOverride.status).json(fake.recordingsOverride.body);
    const list = fake.recordings.get(cam);
    if (!list) return void res.status(503).json({ error: 'camera_offline' });
    return list;
  };
  app.get('/api/cameras/:cam/recordings/days', (req, res) => {
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return void res.status(400).json({ error: 'invalid', detail: 'month must be YYYY-MM' });
    const list = recordingsOf(req.params.cam, res);
    if (!list) return;
    const ymd = month.replace('-', '');
    const days = new Set<number>();
    for (const r of list) {
      const d = /_(?:DST)?(\d{8})_/.exec(r.id)?.[1];
      if (d?.startsWith(ymd)) days.add(Number(d.slice(6, 8)));
    }
    res.json({ month, days: [...days].sort((a, b) => a - b) });
  });
  app.get('/api/cameras/:cam/recordings', (req, res) => {
    const r = range(req.query);
    const stream = req.query.stream;
    if (!r || (stream !== 'sub' && stream !== 'main')) return void res.status(400).json({ error: 'invalid', detail: 'from, to and stream' });
    if (r[1] - r[0] > 48 * 3_600_000) return void res.status(400).json({ error: 'invalid', detail: 'at most 48 hours' });
    const list = recordingsOf(req.params.cam, res);
    if (!list) return;
    res.json(
      list
        .filter((x) => x.stream === stream && x.start <= r[1] && x.end >= r[0])
        .sort((a, b) => a.start - b.start)
        .map((x) => ({ id: x.id, start: x.start, end: x.end, stream: x.stream, size: x.body.length, kinds: x.kinds ?? [], clipId: x.clipId ?? null })),
    );
  });
  // GET and HEAD (Express answers HEAD with the GET route; sendFile honours it).
  app.get('/api/cameras/:cam/recordings/:id', (req, res) => {
    const id = req.params.id;
    if (id.length > 128 || !REC_ID.test(id)) return void res.status(400).json({ error: 'invalid', detail: 'malformed id' });
    const list = recordingsOf(req.params.cam, res);
    if (!list) return;
    const rec = list.find((x) => x.id === id);
    if (!rec) return void res.status(404).json({ error: 'unknown_recording' });
    if (req.method === 'GET') fake.recordingFetches.push(id);
    if (req.method === 'GET' && fake.recordingDropAfter !== null) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(rec.body.length) });
      res.write(rec.body.subarray(0, fake.recordingDropAfter));
      return void setTimeout(() => res.socket?.destroy(), 20);
    }
    const file = join(dir, `rec-${randomBytes(8).toString('hex')}.mp4`);
    writeFileSync(file, rec.body);
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(file, { headers: { 'Content-Type': 'video/mp4' } });
  });
```

Update the file's header comment (lines 1-4) so it names the new routes:

```ts
// A small stand-in for cam-proxy (github.com/klaushofrichter/cam-proxy),
// following its openapi.yaml for the routes cams uses: the event stream,
// clips, stills, previews and SD recordings. Tests set its data and switches
// directly; e2e runs it as a process (bottom of the file).
```

In `e2e/fakeProxyData.ts`, replace the first three comment lines with:

```ts
// What the e2e fake cam-proxy (test/proxy/fakeProxy.ts) holds: the last ten
// minutes of stills and sprites for Den, and one clip covering today for
// Barn, whose camera refuses downloads like the real one. It holds no SD
// recordings: its recordings routes answer 503 camera_offline, so cams lists
// Den's and Barn's days with the camera's own Search and plays FTP copies,
// as with a proxy that can't reach its camera. The media are
// ffmpeg test patterns made at start-up (nothing committed).
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `npx vitest run --project node test/fakeProxyRecordings.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. Nothing in cams calls these routes yet.

- [ ] **Step 6: Commit**

```bash
git add test/proxy/fakeProxy.ts test/fakeProxyRecordings.test.ts e2e/fakeProxyData.ts
git commit -m "test: the fake cam-proxy serves SD recordings like cam-proxy's recordings API"
```

---

### Task 2: The proxy recordings client

**Files:**
- Create: `server/recordings/errors.ts`
- Create: `server/recordings/proxyRecordings.ts`
- Modify: `server/recordings/service.ts:28-33` (the `RecordingError` class moves out; re-exported)
- Modify: `server/proxy/client.ts:119` (`errorCode` exported)
- Test: `test/proxyRecordings.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `FakeRecording`, `fake.recordings`, `fake.recordingsOverride`. Existing `getProxyClient(id)`, `proxyCameraId(id)`, `ProxyError(code, message, status?, upstream?)`, `ProxyClient.json()`/`open()` from `server/proxy/client.ts`.
- Produces:
  - `server/recordings/errors.ts`: `export class RecordingError extends Error { code: 'unknown_clip' | 'thumbnail_unavailable' | 'recordings_unavailable' }` (also re-exported from `service.ts`, so existing imports keep working).
  - `server/proxy/client.ts`: `export async function errorCode(res: Response): Promise<string | undefined>`.
  - `server/recordings/proxyRecordings.ts`:
    - `export interface ProxyRecording { id: string; start: number; end: number; stream: 'sub' | 'main'; size: number; kinds: string[]; clipId: number | null }`
    - `export function listProxyRecordings(cameraId: string, from: number, to: number, stream: 'sub' | 'main'): Promise<ProxyRecording[]>`
    - `export function listProxyDays(cameraId: string, month: string): Promise<string[]>` (`YYYY-MM-DD` strings, sorted)
    - `export function openProxyRecording(cameraId: string, id: string, signal?: AbortSignal): Promise<{ stream: Readable; size: number | null }>`. It throws `RecordingError('unknown_clip')` on 404 `unknown_recording`, and `ProxyError` otherwise.
    - `export function fallsBack(err: unknown, signal?: AbortSignal): boolean`
    - `export function logProxyFailure(cameraId: string, what: string, err: unknown): void`

- [ ] **Step 1: Write the failing test**

Create `test/proxyRecordings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'util';
import { setCameras } from '../server/cameraRegistry';
import { logger } from '../server/logger';
import { resetProxyClients } from '../server/proxy/client';
import { RecordingError } from '../server/recordings/errors';
import { fallsBack, listProxyDays, listProxyRecordings, logProxyFailure, openProxyRecording } from '../server/recordings/proxyRecordings';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

// The client for cam-proxy's recordings API (spec 2026-10-02).
const SUB = 'RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4';
const MAIN = 'RecM0A_DST20261001_211129_211209_0_5514C080000000_66A92E.mp4';
const GONE = 'RecS0A_DST20261001_000000_000010_0_5514C080000000_1.mp4';
const T0 = 1_790_000_000_000;

let fake: FakeProxy;
beforeEach(async () => {
  fake = await startFakeProxy();
  // cams calls the camera "den"; its proxy calls it "cam1".
  setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } }]);
  resetProxyClients();
  fake.recordings.set('cam1', [
    { id: SUB, start: T0, end: T0 + 38_000, stream: 'sub', body: Buffer.from('sub-bytes') },
    { id: MAIN, start: T0, end: T0 + 40_000, stream: 'main', body: Buffer.from('main-bytes'), kinds: ['person'], clipId: 1312 },
  ]);
});
afterEach(async () => {
  await fake.stop();
  setCameras([]);
  resetProxyClients();
  vi.restoreAllMocks();
});

const text = async (s: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString();
};
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );

describe('proxy recordings client', () => {
  it('lists one stream under the proxy’s camera id', async () => {
    expect(await listProxyRecordings('den', T0 - 1, T0 + 1, 'main')).toEqual([{ id: MAIN, start: T0, end: T0 + 40_000, stream: 'main', size: 10, kinds: ['person'], clipId: 1312 }]);
    expect(fake.requests.at(-1)).toMatchObject({ path: '/api/cameras/cam1/recordings', query: { from: String(T0 - 1), to: String(T0 + 1), stream: 'main' } });
  });

  // Review focus 4: an id is later used in a URL; only well-formed names pass.
  it('drops entries that are not a well-formed recording, and refuses a list that is not a list', async () => {
    fake.recordings.get('cam1')!.push({ id: '../../etc/passwd.mp4', start: T0, end: T0, stream: 'sub', body: Buffer.from('x') });
    expect((await listProxyRecordings('den', T0 - 1, T0 + 1, 'sub')).map((r) => r.id)).toEqual([SUB]);
    fake.recordingsOverride = { status: 200, body: { not: 'a list' } };
    const err = await caught(listProxyRecordings('den', T0 - 1, T0 + 1, 'sub'));
    expect(err).toMatchObject({ name: 'ProxyError', code: 'proxy_error' });
    expect(fallsBack(err)).toBe(true);
  });

  it('reads the month’s days, dropping any that are not a day of it', async () => {
    expect(await listProxyDays('den', '2026-10')).toEqual(['2026-10-01']);
    fake.recordingsOverride = { status: 200, body: { month: '2026-09', days: [0, 3, 3, 30, 31, 2.5, '4'] } };
    expect(await listProxyDays('den', '2026-09')).toEqual(['2026-09-03', '2026-09-30']);
    fake.recordingsOverride = { status: 200, body: { month: '2026-09' } };
    expect(await caught(listProxyDays('den', '2026-09'))).toMatchObject({ name: 'ProxyError' });
  });

  it('opens a file with its size', async () => {
    const got = await openProxyRecording('den', SUB);
    expect(got.size).toBe(9);
    expect(await text(got.stream)).toBe('sub-bytes');
    expect(fake.requests.at(-1)?.path).toBe(`/api/cameras/cam1/recordings/${SUB}`);
  });

  it('calls a recording gone from the SD card unknown_clip, which never falls back', async () => {
    const err = await caught(openProxyRecording('den', GONE));
    expect(err).toBeInstanceOf(RecordingError);
    expect((err as RecordingError).code).toBe('unknown_clip');
    expect(fallsBack(err)).toBe(false);
  });

  // Review focus 1: an older cam-proxy has no recordings API (a plain 404).
  it.each([
    ['502', { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } }],
    ['503', { status: 503, body: { error: 'camera_offline' } }],
    ['400 (a bug in cams)', { status: 400, body: { error: 'invalid' } }],
    ['an older cam-proxy without the API (plain 404)', { status: 404, body: { error: 'not_found' } }],
  ])('falls back on %s, for the list, the days and a file', async (_name, answer) => {
    fake.recordingsOverride = answer;
    for (const p of [listProxyRecordings('den', 0, 1, 'sub'), listProxyDays('den', '2026-10'), openProxyRecording('den', SUB)]) {
      const err = await caught(p);
      expect(err).toMatchObject({ name: 'ProxyError', status: answer.status });
      expect(fallsBack(err)).toBe(true);
    }
  });

  it('falls back when the proxy is unreachable or refuses the token', async () => {
    fake.offline = true;
    let err = await caught(listProxyRecordings('den', 0, 1, 'sub'));
    expect(err).toMatchObject({ name: 'ProxyError', code: 'proxy_unreachable' });
    expect(fallsBack(err)).toBe(true);
    fake.offline = false;
    fake.token = 'another-token-'.padEnd(48, 'x');
    err = await caught(openProxyRecording('den', SUB));
    expect(err).toMatchObject({ name: 'ProxyError', code: 'proxy_unauthorized' });
    expect(fallsBack(err)).toBe(true);
  });

  it('never falls back once the viewer left', async () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(fallsBack(new Error('aborted'), ctl.signal)).toBe(false);
  });

  it('answers proxy_unreachable for a camera without a cam-proxy', async () => {
    setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]);
    resetProxyClients();
    expect(await caught(listProxyRecordings('den', 0, 1, 'sub'))).toMatchObject({ name: 'ProxyError', code: 'proxy_unreachable' });
  });

  it('logs a failure at warn, a 400 at error, never with the token', async () => {
    const lines: { level: string; text: string }[] = [];
    for (const level of ['warn', 'error'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => void lines.push({ level, text: inspect(a, { depth: 6 }) })) as never);
    }
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    logProxyFailure('den', '20261001-211129-211209', await caught(openProxyRecording('den', SUB)));
    fake.recordingsOverride = { status: 400, body: { error: 'invalid' } };
    logProxyFailure('den', '20261001-211129-211209', await caught(openProxyRecording('den', SUB)));
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
    expect(lines[0].text).toContain('proxy_recordings_failed');
    expect(lines[0].text).toContain('20261001-211129-211209');
    expect(lines[0].text).toContain('camera_offline');
    expect(lines.map((l) => l.text).join('\n')).not.toContain(FAKE_TOKEN);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project node test/proxyRecordings.test.ts`
Expected: FAIL. `Cannot find module '../server/recordings/errors'` (or `proxyRecordings`).

- [ ] **Step 3: Move `RecordingError` and export `errorCode`**

Create `server/recordings/errors.ts`:

```ts
// The recordings service's errors, in their own module so the proxy
// recordings client can throw them without importing the service.
export class RecordingError extends Error {
  constructor(readonly code: 'unknown_clip' | 'thumbnail_unavailable' | 'recordings_unavailable', message: string) {
    super(message);
    this.name = 'RecordingError';
  }
}
```

In `server/recordings/service.ts`, delete the `export class RecordingError … }` block (lines 28-33). Add these with the other imports at the top:

```ts
import { RecordingError } from './errors';
export { RecordingError } from './errors';
```

In `server/proxy/client.ts`, change line 119 from `async function errorCode(res: Response): Promise<string | undefined> {` to:

```ts
export async function errorCode(res: Response): Promise<string | undefined> {
```

- [ ] **Step 4: Write the client module**

Create `server/recordings/proxyRecordings.ts`:

```ts
import { Readable } from 'stream';
import { logger } from '../logger';
import { errorCode, getProxyClient, proxyCameraId, ProxyError, type ProxyClient } from '../proxy/client';
import { RecordingError } from './errors';

// A camera's SD-card recordings through its cam-proxy's recordings API
// (cam-proxy spec 2026-10-02-baichuan-recordings-design, section 2): the proxy
// lists them with the camera's Search, one Search at a time, and fetches the
// files over Baichuan, which works while the camera refuses HTTP Download.

export interface ProxyRecording {
  id: string; // the camera's file name, without the folder
  start: number; // unix ms
  end: number;
  stream: 'sub' | 'main';
  size: number; // bytes
  kinds: string[];
  clipId: number | null; // the proxy's FTP copy of the same recording
}

// cam-proxy's pattern for an SD file name (at most 128 characters). An id is
// used in a URL later, so nothing else passes.
const REC_ID = /^Rec[MS][0-9A-Za-z]{2}_(DST)?\d{8}_\d{6}_\d{6}_[0-9A-Za-z_]+\.mp4$/;

// The proxy can be switched off between two calls.
function clientFor(cameraId: string): ProxyClient {
  const client = getProxyClient(cameraId);
  if (!client) throw new ProxyError('proxy_unreachable', 'the camera has no cam-proxy in use');
  return client;
}

function base(cameraId: string): string {
  return `/api/cameras/${encodeURIComponent(proxyCameraId(cameraId))}/recordings`;
}

function isRecording(x: unknown, stream: 'sub' | 'main'): boolean {
  const r = x as Partial<ProxyRecording> | null;
  return (
    !!r &&
    typeof r.id === 'string' &&
    r.id.length <= 128 &&
    REC_ID.test(r.id) &&
    r.stream === stream &&
    Number.isSafeInteger(r.start) &&
    Number.isSafeInteger(r.end) &&
    Number.isSafeInteger(r.size) &&
    (r.size as number) >= 0
  );
}

// The recordings of one stream that overlap [from, to] (unix ms). Entries that
// aren't a well-formed recording of that stream are dropped.
export async function listProxyRecordings(cameraId: string, from: number, to: number, stream: 'sub' | 'main'): Promise<ProxyRecording[]> {
  const body = await clientFor(cameraId).json<unknown>(base(cameraId), { from, to, stream });
  if (!Array.isArray(body)) throw new ProxyError('proxy_error', 'cam-proxy sent a recordings list that is not a list');
  return body
    .filter((x) => isRecording(x, stream))
    .map((x) => {
      const r = x as ProxyRecording;
      return {
        id: r.id,
        start: r.start,
        end: r.end,
        stream: r.stream,
        size: r.size,
        kinds: Array.isArray(r.kinds) ? r.kinds.filter((k): k is string => typeof k === 'string') : [],
        clipId: Number.isSafeInteger(r.clipId) ? r.clipId : null,
      };
    });
}

// The days (YYYY-MM-DD) of a camera-local month (YYYY-MM) with recordings.
export async function listProxyDays(cameraId: string, month: string): Promise<string[]> {
  const body = await clientFor(cameraId).json<{ days?: unknown } | null>(`${base(cameraId)}/days`, { month });
  if (!body || !Array.isArray(body.days)) throw new ProxyError('proxy_error', 'cam-proxy sent a day list without days');
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const days = new Set(body.days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= last));
  return [...days].sort((a, b) => a - b).map((d) => `${month}-${String(d).padStart(2, '0')}`);
}

// One recording's file, streamed as it arrives (the proxy fetches it over
// Baichuan on the first request). 404 unknown_recording: the recording is
// gone from the SD card, which is final.
export async function openProxyRecording(cameraId: string, id: string, signal?: AbortSignal): Promise<{ stream: Readable; size: number | null }> {
  const client = clientFor(cameraId);
  const res = await client.open(`${base(cameraId)}/${encodeURIComponent(id)}`, undefined, { signal, timeoutMs: 30_000, idleMs: 30_000 });
  if (!res.ok || !res.body) {
    const upstream = await errorCode(res);
    if (res.status === 404 && upstream === 'unknown_recording') throw new RecordingError('unknown_clip', 'the recording is gone from the SD card');
    throw new ProxyError('proxy_error', `cam-proxy ${client.host()} answered ${res.status} for a recording`, res.status, upstream);
  }
  const cl = res.headers.get('content-length');
  return { stream: Readable.fromWeb(res.body as import('stream/web').ReadableStream), size: cl && /^\d+$/.test(cl) ? Number(cl) : null };
}

// Whether cams tries its next route after this failure: everything but a
// recording gone from the SD card and the viewer's own abort. 502/503, an
// unreachable proxy, a refused token, a 400 (a bug in cams) and an older
// cam-proxy without the API (a plain 404) all fall back.
export function fallsBack(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  return !(err instanceof RecordingError);
}

// `what`: the clip id, or the day or month being listed. ProxyError messages
// name the proxy's host only, never its token.
export function logProxyFailure(cameraId: string, what: string, err: unknown): void {
  const e = err instanceof ProxyError ? err : undefined;
  const fields = { cameraId, what, code: e?.code ?? 'error', status: e?.status, upstream: e?.upstream, message: (err as Error).message };
  if (e?.status === 400) logger.error(fields, 'proxy_recordings_failed');
  else logger.warn(fields, 'proxy_recordings_failed');
}
```

- [ ] **Step 5: Run it to make sure it passes**

Run: `npx vitest run --project node test/proxyRecordings.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Type-check and run the whole suite**

Run: `npm run build && npm test`
Expected: the build succeeds (`RecordingError` still imports from `service.ts` everywhere); all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/recordings/errors.ts server/recordings/proxyRecordings.ts server/recordings/service.ts server/proxy/client.ts test/proxyRecordings.test.ts
git commit -m "feat(recordings): client for cam-proxy's recordings API"
```

---

### Task 3: The day list and the month list through the proxy, and `downloadsState`

**Files:**
- Modify: `server/recordings/service.ts`: imports (lines 7-16), `days()` (212-219), `day()` (221-267), `downloadsState()` (356-361); add `dayBounds()`, `DownloadsState`, `proxyRecordingsFailed`, `viaProxy()`
- Modify: `test/camera/sim.ts`: the `searches` counter
- Create: `test/proxy/seedRecordings.ts`
- Modify: `test/proxySwitch.test.ts:161`
- Test: `test/recordingsViaProxy.test.ts` (create)

**Interfaces:**
- Consumes: Task 2's `listProxyRecordings(cameraId, from, to, stream)`, `listProxyDays(cameraId, month)`, `fallsBack(err, signal?)`, `logProxyFailure(cameraId, what, err)`, `ProxyRecording`. Task 1's `FakeRecording`, `fake.recordings`, `fake.recordingsOverride`.
- Produces:
  - `server/recordings/service.ts`: `export type DownloadsState = 'ok' | 'proxy-recordings' | 'proxy' | 'unavailable'`; `downloadsState(cameraId: string): DownloadsState`; `export function dayBounds(date: string, t: TimeInfo): { from: number; to: number }`; and on `RecordingsService`: `private viaProxy<T>(cameraId: string, what: string, ask: () => Promise<T>, signal?: AbortSignal): Promise<T | null>`, plus `private readonly proxyRecordingsFailed: Map<string, boolean>`.
  - The `names` map of a day now holds either camera paths (camera Search) or bare file names (proxy list).
  - `test/camera/sim.ts`: `SimState.searches: number`.
  - `test/proxy/seedRecordings.ts`: `seedRecordings(fake: FakeProxy, cameraId: string, date: string, body?: (stream: 'sub' | 'main', id: string) => Buffer): Promise<FakeRecording[]>` and `recordingOf(list: FakeRecording[], clipId: string, stream: 'sub' | 'main'): FakeRecording`.

- [ ] **Step 1: Add the sim's Search counter and the seeding helper**

In `test/camera/sim.ts`, in `interface SimState` after `readonly downloadOrder: string[];`, add:

```ts
  readonly searches: number; // camera Searches (day and month) answered
```

In the `state` object, after `get downloadOrder() { return c.downloadOrder; },`, add:

```ts
    get searches() { return c.searches; },
```

Create `test/proxy/seedRecordings.ts`:

```ts
import { getClient } from '../../server/reolink/clients';
import { clipTimes, parseClipName } from '../../server/recordings/clipNames';
import type { FakeProxy, FakeRecording } from './fakeProxy';

// Gives the fake cam-proxy the SD recordings cam-sim holds for `date`, as the
// real proxy lists them (it runs the same Search against the same camera).
// Bodies are made up, so a test can tell where bytes came from; `body`
// replaces them (a real MP4 for thumbnails). This uses the camera's Search:
// read the sim's counters after it.
export async function seedRecordings(fake: FakeProxy, cameraId: string, date: string, body?: (stream: 'sub' | 'main', id: string) => Buffer): Promise<FakeRecording[]> {
  const client = getClient(cameraId);
  if (!client) throw new Error(`no camera ${cameraId}`);
  const time = await client.timeInfo();
  const list: FakeRecording[] = [];
  for (const stream of ['sub', 'main'] as const) {
    for (const f of await client.searchDay(date, stream)) {
      const p = parseClipName(f.name);
      if (!p) continue;
      const t = clipTimes(p, time);
      const id = f.name.slice(f.name.lastIndexOf('/') + 1);
      list.push({ id, start: Date.parse(t.start), end: Date.parse(t.end), stream, body: body?.(stream, id) ?? Buffer.from(`sd ${stream} ${id} `.repeat(stream === 'main' ? 40 : 10)) });
    }
  }
  fake.recordings.set(cameraId, [...(fake.recordings.get(cameraId) ?? []), ...list]);
  return list;
}

// The seeded file of one stream for an event id (YYYYMMDD-HHMMSS-HHMMSS):
// the name holds the date and the start time.
export function recordingOf(list: FakeRecording[], clipId: string, stream: 'sub' | 'main'): FakeRecording {
  const key = `${clipId.slice(0, 8)}_${clipId.slice(9, 15)}_`;
  const r = list.find((x) => x.stream === stream && x.id.includes(key));
  if (!r) throw new Error(`no ${stream} recording for ${clipId}`);
  return r;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/recordingsViaProxy.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { loadProxyState, setProxyEnabled } from '../server/proxyState';
import { getClient, resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { dayBounds, resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, type SimState } from './camera/sim';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { recordingOf, seedRecordings } from './proxy/seedRecordings';

// Spec 2026-10-02 (recordings via cam-proxy): for a camera with a cam-proxy
// the day's list and the month's days come from the proxy's recordings API,
// so every camera Search goes through the proxy's one searcher; the camera's
// own Search only when the proxy can't answer.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const chicago = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const today = () => chicago(Date.now());
const yesterday = () => chicago(Date.now() - 86_400_000);

let cam: Server;
let state: SimState;
let fake: FakeProxy;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-viaproxy-'));
  process.env.CACHE_DIR = cacheDir;
  process.env.PROXY_STATE_FILE = join(cacheDir, 'proxy-state.json');
  loadProxyState();
  const sim = await createSimCamera({ user: 'u', password: 'p' });
  state = sim.state;
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  const host = `127.0.0.1:${(cam.address() as AddressInfo).port}`;
  fake = await startFakeProxy();
  setCameras([
    { id: 'cam1', name: 'Den', host, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } },
    { id: 'porch', name: 'Porch', host, protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetClients();
  resetProxyClients();
  resetRecordings();
});
afterEach(async () => {
  await new Promise<void>((r) => cam.close(() => r()));
  await fake.stop();
  setCameras([]);
  process.env.CACHE_DIR = workerCacheDir;
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
  rmSync(cacheDir, { recursive: true, force: true });
});

type Day = { events: { id: string; start: string; end: string; triggers: string[]; sizeSub: number | null; sizeMain: number | null }[]; downloads: string };
const events = async (id = 'cam1', date = today()) => (await request(createApp()).get(`/api/cameras/${id}/events?date=${date}`).set('Cookie', auth)).body as Day;
const daysOf = async (id: string, month: string) => (await request(createApp()).get(`/api/cameras/${id}/days?month=${month}`).set('Cookie', auth)).body as { days: string[] };
const recordingAsks = () => fake.requests.filter((r) => r.path.startsWith('/api/cameras/cam1/recordings'));
const shape = (d: Day) => d.events.map((e) => [e.id, e.start, e.end, e.triggers]);

describe('the day’s list and the month’s days through cam-proxy', () => {
  it('lists the day from the proxy, sub then main, paired like the camera’s Search, without a camera Search', async () => {
    const date = today();
    const list = await seedRecordings(fake, 'cam1', date);
    const searches = state.searches;
    const viaProxy = await events();
    expect(state.searches).toBe(searches);
    expect(viaProxy.downloads).toBe('proxy-recordings');
    const asks = recordingAsks();
    expect(asks.map((r) => r.query.stream)).toEqual(['sub', 'main']);
    const bounds = dayBounds(date, await getClient('cam1')!.timeInfo());
    expect(asks.map((r) => [Number(r.query.from), Number(r.query.to)])).toEqual([[bounds.from, bounds.to], [bounds.from, bounds.to]]);
    expect(viaProxy.events.length).toBeGreaterThan(0);
    for (const ev of viaProxy.events) {
      expect(ev.sizeSub).toBe(recordingOf(list, ev.id, 'sub').body.length);
      expect(ev.sizeMain).toBe(recordingOf(list, ev.id, 'main').body.length);
    }
    // The same events as the camera's own Search gives.
    resetRecordings();
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    expect(shape(viaProxy)).toEqual(shape(await events()));
  });

  // Review focus 1: an older cam-proxy answers a plain 404.
  it.each([
    ['502', () => void (fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } })],
    ['503', () => void (fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } })],
    ['400', () => void (fake.recordingsOverride = { status: 400, body: { error: 'invalid' } })],
    ['an older cam-proxy (plain 404)', () => void (fake.recordingsOverride = { status: 404, body: { error: 'not_found' } })],
    ['a refused token', () => void (fake.token = 'another-token-'.padEnd(48, 'x'))],
    ['an unreachable proxy', () => void (fake.offline = true)],
  ])('falls back to the camera’s Search on %s', async (_name, breakIt) => {
    await seedRecordings(fake, 'cam1', today());
    const searches = state.searches;
    breakIt();
    const day = await events();
    expect(day.events.length).toBeGreaterThan(0);
    expect(state.searches).toBe(searches + 2);
    expect(day.downloads).toBe('proxy');
  }, 15_000);

  it('says proxy-recordings again once the proxy answers again', async () => {
    await seedRecordings(fake, 'cam1', today());
    await seedRecordings(fake, 'cam1', yesterday());
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    expect((await events()).downloads).toBe('proxy');
    fake.recordingsOverride = null;
    expect((await events('cam1', yesterday())).downloads).toBe('proxy-recordings');
  });

  it('reads the month’s days from the proxy; the camera’s month Search only when the proxy fails', async () => {
    const date = today();
    const month = date.slice(0, 7);
    await seedRecordings(fake, 'cam1', date);
    const searches = state.searches;
    expect((await daysOf('cam1', month)).days).toEqual([date]);
    expect(state.searches).toBe(searches);
    expect(recordingAsks().at(-1)).toMatchObject({ path: '/api/cameras/cam1/recordings/days', query: { month } });
    resetRecordings();
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'search_failed' } };
    expect((await daysOf('cam1', month)).days).toContain(date);
    expect(state.searches).toBe(searches + 1);
  });

  // Review focus 3: a day on a DST change, and east of UTC.
  it('asks for a camera-local day wide enough for either offset (dayBounds)', () => {
    // Chicago, the fall-back day: CDT midnight is 05:00Z, CST midnight 06:00Z.
    expect(dayBounds('2026-11-01', { stdOffsetMinutes: -360, dstOffsetMinutes: 60 })).toEqual({ from: Date.parse('2026-11-01T05:00:00Z'), to: Date.parse('2026-11-02T06:00:00Z') - 1 });
    // Berlin, the spring-forward day: CEST midnight is 22:00Z the day before, CET midnight 23:00Z.
    expect(dayBounds('2026-03-29', { stdOffsetMinutes: 60, dstOffsetMinutes: 60 })).toEqual({ from: Date.parse('2026-03-28T22:00:00Z'), to: Date.parse('2026-03-29T23:00:00Z') - 1 });
    // No DST: exactly the day.
    expect(dayBounds('2026-10-02', { stdOffsetMinutes: 0, dstOffsetMinutes: 0 })).toEqual({ from: Date.parse('2026-10-02T00:00:00Z'), to: Date.parse('2026-10-03T00:00:00Z') - 1 });
  });

  it('leaves a camera without a cam-proxy unchanged: the camera’s Search, no proxy request, downloads ok', async () => {
    const searches = state.searches;
    const day = await events('porch');
    expect(day.events.length).toBeGreaterThan(0);
    expect(state.searches).toBe(searches + 2);
    expect(day.downloads).toBe('ok');
    await daysOf('porch', today().slice(0, 7));
    expect(state.searches).toBe(searches + 3);
    expect(fake.requests.some((r) => r.path.includes('/recordings'))).toBe(false);
  });

  it('asks the camera, not the proxy, while the cam-proxy is switched off', async () => {
    await setProxyEnabled('cam1', false);
    const searches = state.searches;
    const day = await events();
    expect(state.searches).toBe(searches + 2);
    expect(day.downloads).toBe('ok');
    expect(fake.requests.some((r) => r.path.includes('/recordings'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run --project node test/recordingsViaProxy.test.ts`
Expected: FAIL. `dayBounds` is not exported (`dayBounds is not a function`); the other tests fail on `downloads` (`'proxy'` vs `'proxy-recordings'`) and on the Search counts.

- [ ] **Step 4: Implement**

In `server/recordings/service.ts`:

Change the `clipNames` import (line 11) to include `TimeInfo`:

```ts
import { clipIdOf, clipTimes, CLIP_ID, parseClipName, ParsedClip, TimeInfo, Trigger } from './clipNames';
```

Add, below the other imports:

```ts
import { fallsBack, listProxyDays, listProxyRecordings, logProxyFailure, type ProxyRecording } from './proxyRecordings';
```

Change the `DayEntry` interface's `names` comment line (line 38) to:

```ts
  // Per event: the camera's path of each stream's file (camera Search), or the
  // bare file name (the proxy's list).
  names: Map<string, { sub?: string; main?: string }>;
```

After `export function isStillRecording(…) { … }` (ends line 102), add:

```ts
// A camera-local day's bounds in unix ms, for the proxy's list. TimeInfo
// doesn't say whether DST is in effect that day, so the window runs from
// midnight at the DST offset to the next midnight at standard time; the
// list is filtered by the names' date afterwards. At most 25 hours.
export function dayBounds(date: string, t: TimeInfo): { from: number; to: number } {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return {
    from: midnight - (t.stdOffsetMinutes + t.dstOffsetMinutes) * 60_000,
    to: midnight + 86_400_000 - t.stdOffsetMinutes * 60_000 - 1,
  };
}

// 'proxy-recordings': from the cam-proxy's recordings API (the SD card).
// 'proxy': the camera has a cam-proxy, but its last recordings request
// failed, so recordings come from its FTP copies. 'ok' and 'unavailable':
// cameras without a proxy (the camera's breaker).
export type DownloadsState = 'ok' | 'proxy-recordings' | 'proxy' | 'unavailable';
```

In `class RecordingsService`, after `private readonly transfers = new Map<string, PriorityGate>();` (line 116), add:

```ts
  // Per camera with a cam-proxy: whether its last recordings request failed.
  private readonly proxyRecordingsFailed = new Map<string, boolean>();

  // Runs `ask` against the camera's cam-proxy (spec 2026-10-02). null: "use
  // the next route" (no proxy in use, or a failure that falls back, logged as
  // proxy_recordings_failed). A recording gone from the SD card
  // (unknown_clip) and an abort are thrown. `what` is the clip id, or the day
  // or month being listed, for the log.
  private async viaProxy<T>(cameraId: string, what: string, ask: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
    if (!proxyActive(cameraId)) return null;
    try {
      const value = await ask();
      this.proxyRecordingsFailed.set(cameraId, false);
      return value;
    } catch (err) {
      if (err instanceof RecordingError) this.proxyRecordingsFailed.set(cameraId, false); // the proxy answered
      if (!fallsBack(err, signal)) throw err;
      this.proxyRecordingsFailed.set(cameraId, true);
      logProxyFailure(cameraId, what, err);
      return null;
    }
  }
```

Replace `days()` (lines 212-219) with:

```ts
  // A camera with a cam-proxy: the proxy's month list, so the camera is
  // searched by the proxy's one searcher only (an overlapping Search comes
  // back empty without an error); its own month Search when the proxy can't.
  async days(cameraId: string, month: string): Promise<string[]> {
    const key = `${cameraId}|${month}`;
    const hit = this.days_.get(key);
    if (hit && Date.now() - hit.at < MONTH_TTL) return hit.days;
    const days = (await this.viaProxy(cameraId, month, () => listProxyDays(cameraId, month))) ?? (await this.client(cameraId).searchMonth(month));
    this.days_.set(key, { at: Date.now(), days });
    return days;
  }
```

In `day()`, replace the first line inside `const work = (async () => {` (line 231, `const [sub, main] = await Promise.all([client.searchDay(date, 'sub'), client.searchDay(date, 'main')]);`) with:

```ts
      // A camera with a cam-proxy: the proxy's list, sub then main, from the
      // camera-local day's bounds; its own Search when the proxy can't answer.
      const { from, to } = dayBounds(date, time);
      const files = (list: ProxyRecording[]) => list.map((r) => ({ name: r.id, size: r.size }));
      const proxied = await this.viaProxy(cameraId, date, async () => {
        const subList = files(await listProxyRecordings(cameraId, from, to, 'sub'));
        const mainList = files(await listProxyRecordings(cameraId, from, to, 'main'));
        return [subList, mainList] as const;
      });
      const [sub, main] = proxied ?? (await Promise.all([client.searchDay(date, 'sub'), client.searchDay(date, 'main')]));
```

Keep the rest of `day()` as it is. `parseClipName()` accepts a bare file name.

Replace `downloadsState()` and its comment (lines 356-361) with:

```ts
  downloadsState(cameraId: string): DownloadsState {
    if (proxyActive(cameraId)) return this.proxyRecordingsFailed.get(cameraId) ? 'proxy' : 'proxy-recordings';
    return (this.health.get(cameraId)?.failures ?? 0) >= BREAKER_FAILURES ? 'unavailable' : 'ok';
  }
```

- [ ] **Step 5: Update the expectation that changes by design**

In `test/proxySwitch.test.ts`, line 161, a camera with its proxy on and no request yet now reads `proxy-recordings`:

```ts
    expect(getRecordings().downloadsState('den')).toBe('proxy-recordings');
```

- [ ] **Step 6: Run the new tests and the whole suite**

Run: `npx vitest run --project node test/recordingsViaProxy.test.ts`
Expected: PASS (12 tests).

Run: `npm run build && npm test`
Expected: PASS. The fake holds no recordings for the tests that predate this plan, so it answers 503 and they keep the camera's Search. `proxyFirst.test.ts` and `proxyClips.test.ts` still see `downloads: 'proxy'`.

- [ ] **Step 7: Commit**

```bash
git add server/recordings/service.ts test/camera/sim.ts test/proxy/seedRecordings.ts test/recordingsViaProxy.test.ts test/proxySwitch.test.ts
git commit -m "feat(recordings): day and month lists through cam-proxy's recordings API"
```

---

### Task 4: Playback and clip thumbnails from the proxy's recordings

**Files:**
- Modify: `server/recordings/service.ts`: imports, module helpers, `withClip()` (lines 403-441), a new `cameraPath()`
- Test: `test/recordingsViaProxyClips.test.ts` (create)

**Interfaces:**
- Consumes: Task 2's `openProxyRecording(cameraId, id, signal?)`; Task 3's `viaProxy()`, `seedRecordings()`, `recordingOf()`, `SimState.searches`; Task 1's `fake.recordingsOverride`, `fake.recordingDropAfter`, `fake.recordingFetches`.
- Produces (in `server/recordings/service.ts`):
  - module helpers `function baseName(name: string): string` and `function dateOf(clipId: string): string` (`YYYY-MM-DD`)
  - `private cameraPath(cameraId: string, clipId: string, name: string, stream: 'sub' | 'main'): Promise<string>`. It returns the camera path for a name from the day's list and finds the folder with the camera's own Search when the name is bare. Task 5 uses it.

- [ ] **Step 1: Write the failing test**

Create `test/recordingsViaProxyClips.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { getRecordings, resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, type SimCameraOptions, type SimState } from './camera/sim';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { recordingOf, seedRecordings } from './proxy/seedRecordings';

// Spec 2026-10-02: playback and the clip-based thumbnails of a camera with a
// cam-proxy come from the proxy's recordings API, then its FTP copy, then the
// camera's own download behind the breaker. The proxy's still stays first
// for thumbnails.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CLIP = Buffer.from('ftp copy bytes '.repeat(100));
const STILL = Buffer.concat([JPEG, Buffer.from('still-at-start-plus-2s')]);

let cam: Server;
let state: SimState;
let fake: FakeProxy;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;

async function startCamera(opts: Partial<SimCameraOptions> = {}) {
  const sim = await createSimCamera({ user: 'u', password: 'p', ...opts });
  state = sim.state;
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  const host = `127.0.0.1:${(cam.address() as AddressInfo).port}`;
  setCameras([
    { id: 'cam1', name: 'Den', host, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } },
    { id: 'porch', name: 'Porch', host, protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetClients();
  resetProxyClients();
  resetRecordings();
}

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-viaproxy-clips-'));
  process.env.CACHE_DIR = cacheDir;
  fake = await startFakeProxy();
  await startCamera();
});
afterEach(async () => {
  await new Promise<void>((r) => cam.close(() => r()));
  await fake.stop();
  setCameras([]);
  process.env.CACHE_DIR = workerCacheDir;
  rmSync(cacheDir, { recursive: true, force: true });
});

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
type Day = { events: { id: string; start: string; end: string }[]; downloads: string };
const events = async (id = 'cam1') => (await request(createApp()).get(`/api/cameras/${id}/events?date=${today()}`).set('Cookie', auth)).body as Day;
const video = (id: string, camera = 'cam1') => request(createApp()).get(`/api/cameras/${camera}/clips/${id}/video`).set('Cookie', auth);
const thumb = (id: string) => request(createApp()).get(`/api/cameras/cam1/clips/${id}/thumb.jpg`).set('Cookie', auth);
const ftpCopy = (start: string) => fake.clips.push({ id: 5, cam: 'cam1', start: Date.parse(start) - 1000, end: Date.parse(start) + 30_000, stream: 'sub', events: [], body: CLIP });
const askedFtp = () => fake.requests.some((q) => q.path.endsWith('/clips') || /\/clips\/\d+\.mp4$/.test(q.path));

// The day listed from the proxy (the seeded recordings), and its first event.
async function seeded(body?: (stream: 'sub' | 'main', id: string) => Buffer) {
  const list = await seedRecordings(fake, 'cam1', today(), body);
  const day = await events();
  return { list, day, ev: day.events[0] };
}

// A short real MP4, so ffmpeg can make a thumbnail from it.
function mp4(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'cams-sd-mp4-'));
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'sd.mp4')]);
  const out = readFileSync(join(dir, 'sd.mp4'));
  rmSync(dir, { recursive: true, force: true });
  return out;
}

describe('playback and thumbnails through cam-proxy’s recordings', () => {
  it('plays the SD file from the proxy: no FTP copy, no camera download', async () => {
    const { list, ev } = await seeded();
    ftpCopy(ev.start);
    const r = await binary(video(ev.id));
    expect(r.status).toBe(200);
    const sub = recordingOf(list, ev.id, 'sub');
    expect(Buffer.compare(r.body, sub.body)).toBe(0);
    expect(fake.recordingFetches).toEqual([sub.id]);
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  it.each([
    [502, 'recordings_unavailable'],
    [503, 'camera_offline'],
  ])('plays the FTP copy when the proxy’s recordings answer %i', async (status, error) => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status, body: { error } };
    const r = await binary(video(ev.id));
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    expect(state.downloads).toBe(0);
    expect(getRecordings().downloadsState('cam1')).toBe('proxy');
  });

  // Review focus 2: the list came from the proxy (bare file names).
  it('then the camera, finding the file’s folder with the camera’s Search', async () => {
    const { ev } = await seeded();
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const searches = state.searches;
    const r = await binary(video(ev.id));
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(state.downloads).toBe(1);
    expect(state.searches).toBe(searches + 1);
  });

  it('answers unknown_clip for a recording gone from the SD card, with no fallback', async () => {
    const { list, ev } = await seeded();
    ftpCopy(ev.start);
    const subId = recordingOf(list, ev.id, 'sub').id;
    fake.recordings.set('cam1', list.filter((r) => r.id !== subId));
    const r = await video(ev.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'unknown_clip' });
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  // Review focus 5: nothing was sent to the viewer yet (the file goes to cams' cache first).
  it('falls back to the FTP copy when the proxy’s transfer drops midway', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingDropAfter = 100;
    const r = await binary(video(ev.id));
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
  });

  it('makes thumbnails from the proxy’s still first, without fetching a recording', async () => {
    const { ev } = await seeded();
    fake.stills.set('cam1', new Map([[Date.parse(ev.start) + 2000, STILL]]));
    const r = await binary(thumb(ev.id));
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body, STILL)).toBe(0);
    expect(fake.recordingFetches).toEqual([]);
  });

  it('without a still, makes the thumbnail from the SD file the proxy fetched', async () => {
    const sd = mp4();
    const { list, ev } = await seeded(() => sd);
    const r = await binary(thumb(ev.id));
    expect(r.status).toBe(200);
    expect([...r.body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(fake.recordingFetches).toContain(recordingOf(list, ev.id, 'sub').id);
    expect(state.downloads).toBe(0);
  }, 20_000);

  it('serves a proxy recording while the camera’s transfer slot is busy', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ downloadDelayMs: 3000 });
    const { list, day } = await seeded();
    const [a, b] = day.events;
    // a: the proxy fails, so the camera (3 s per download) holds the slot.
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const slow = video(a.id).then((r) => r);
    await new Promise((r) => setTimeout(r, 300));
    fake.recordingsOverride = null;
    const t0 = Date.now();
    const fast = await binary(video(b.id));
    expect(Buffer.compare(fast.body, recordingOf(list, b.id, 'sub').body)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await slow).status).toBe(200);
  }, 20_000);

  it('leaves a camera without a cam-proxy unchanged: the camera’s download', async () => {
    const day = await events('porch');
    const r = await video(day.events[0].id, 'porch');
    expect(r.status).toBe(200);
    expect(state.downloads).toBe(1);
    expect(fake.requests).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project node test/recordingsViaProxyClips.test.ts`
Expected: FAIL. "plays the SD file from the proxy" gets the camera's file (`state.downloads` is 1, `recordingFetches` is `[]`), "answers unknown_clip" gets 200, and "then the camera" gets an error because the camera can't download a bare file name.

- [ ] **Step 3: Implement**

In `server/recordings/service.ts`, extend the `proxyRecordings` import:

```ts
import { fallsBack, listProxyDays, listProxyRecordings, logProxyFailure, openProxyRecording, type ProxyRecording } from './proxyRecordings';
```

After `function clipSpanEnd(…) { … }` (ends line 110), add:

```ts
// A file name without its folder: the proxy's id for a camera path.
function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

// YYYYMMDD-HHMMSS-HHMMSS → YYYY-MM-DD.
function dateOf(clipId: string): string {
  return `${clipId.slice(0, 4)}-${clipId.slice(4, 6)}-${clipId.slice(6, 8)}`;
}
```

Before `withClip()`, add:

```ts
  // The camera's path of a file from the day's list. A list from the proxy
  // holds bare file names, and the camera's Download needs the folder, so the
  // camera's own Search finds it. That happens only after the proxy just
  // failed, so the proxy isn't searching then.
  private async cameraPath(cameraId: string, clipId: string, name: string, stream: 'sub' | 'main'): Promise<string> {
    if (name.includes('/')) return name;
    const hit = (await this.client(cameraId).searchDay(dateOf(clipId), stream)).find((f) => baseName(f.name) === name);
    if (!hit) throw new RecordingError('unknown_clip', 'no such clip on the camera');
    return hit.name;
  }
```

Replace the `cache.fill` producer in `withClip()` (lines 415-436) with:

```ts
      const path = await this.cache.fill(key, async (tmp) => {
        // 1. The proxy's recordings API: the SD file, fetched over Baichuan
        //    (spec 2026-10-02), outside the camera's transfer slot (the proxy
        //    queues its own transfers). A gone recording ends here.
        const fromSd = await this.viaProxy(cameraId, clipId, async () => {
          const { stream } = await openProxyRecording(cameraId, baseName(sub));
          await pipeline(stream, createWriteStream(tmp));
          return true;
        });
        if (fromSd) return;
        // 2. Its FTP copy (Plan 7), also outside the slot.
        const first = await this.proxyClip(cameraId, clipId);
        if (first) {
          try {
            await pipeline((await openProxyClip(cameraId, first.id)).stream, createWriteStream(tmp));
            return;
          } catch (e) {
            logger.warn({ cameraId, clipId, message: (e as Error).message }, 'proxy_clip_fetch_failed');
          }
        }
        // 3. The camera's own download, in its one transfer slot, behind the
        //    breaker. The proxy was asked above, so a camera refusal is final
        //    here (issue #38: no second lookup); a retry asks the proxy again.
        await this.gate(cameraId).run(
          async () => {
            const res = await this.downloadWithRetry(cameraId, await this.cameraPath(cameraId, clipId, sub, 'sub'));
            await pipeline(res, createWriteStream(tmp));
          },
          { high: priority === 'high', key },
        );
      });
```

`thumbnail()` and `clipThumbnail()` stay as they are. The still comes first, and the clip path now goes through `withClip()`'s new order.

- [ ] **Step 4: Run it to make sure it passes**

Run: `npx vitest run --project node test/recordingsViaProxyClips.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the whole suite**

Run: `npm run build && npm test`
Expected: PASS. The existing tests in `proxyFirst.test.ts` and `proxyClips.test.ts` meet a fake without recordings (503), so they test the FTP-copy and camera steps as before.

- [ ] **Step 6: Commit**

```bash
git add server/recordings/service.ts test/recordingsViaProxyClips.test.ts
git commit -m "feat(recordings): play and thumbnail clips from cam-proxy's recordings first"
```

---

### Task 5: The clip download from the proxy's recordings (no silent 4K downgrade)

Klaus's ruling (2026-10-02): no silent quality downgrade. A **main (4K)** download goes to the proxy's recordings (main), then the camera's HTTP download (main, behind the breaker). It never falls back to the FTP copy, which is the sub stream. If both fail, it answers `503 {"error":"full_quality_unavailable"}`. A **sub** download keeps the FTP copy between the two. This task also adds `GET /api/cameras/:id/clips/:clipId/full-quality` (`{"available": boolean}`), which the Save dialog asks in Task 6.

**Files:**
- Modify: `server/recordings/errors.ts` (a new code, `full_quality_unavailable`)
- Modify: `server/proxy/client.ts:53` (`open()` takes `method: 'HEAD'`)
- Modify: `server/recordings/proxyRecordings.ts` (adds `headProxyRecording()`)
- Modify: `server/recordings/service.ts`: `openDownload()` (lines 504-579); new `handOver()` and `mainAvailable()`; delete `proxyClipFor()` (lines 363-369)
- Modify: `server/routes/recordings.ts` (the `full-quality` route)
- Modify: `test/proxyClips.test.ts:130-140` (a 4K download no longer takes the FTP copy)
- Test: `test/recordingsViaProxyDownloads.test.ts` (create)

`test/proxyFirst.test.ts` stays as it is. Its test "downloads full quality from the camera, the sub stream from the proxy" still holds: the fake has no recordings (503), so main goes to the camera and sub to the FTP copy.

**Interfaces:**
- Consumes: Task 4's `cameraPath()`, `baseName()`, `dateOf()`; Task 3's `viaProxy()`, `seedRecordings()`, `recordingOf()`; Task 2's `openProxyRecording()`; Task 1's fake `HEAD` support.
- Produces:
  - `RecordingError` code `'full_quality_unavailable'` (the route answers 503 with it, through the existing `fail()`).
  - `server/recordings/proxyRecordings.ts`: `export function headProxyRecording(cameraId: string, id: string): Promise<void>` (throws `ProxyError` on any non-2xx).
  - `RecordingsService.openDownload(cameraId: string, clipId: string, quality: 'sub' | 'main', signal?: AbortSignal): Promise<{ stream: Readable; filename: string; size: number | null }>` (same signature, new order).
  - `RecordingsService.mainAvailable(cameraId: string, clipId: string): Promise<boolean>`.
  - `private handOver(got: { stream: Readable; size: number | null }, filename: string, release: () => void, signal?: AbortSignal): { stream: Readable; filename: string; size: number | null }`.
  - Route `GET /api/cameras/:id/clips/:clipId/full-quality` → `200 {"available": boolean}` (`false` also for an unknown clip); 400 for a malformed clip id, 404 for an unknown camera, as the other clip routes.

- [ ] **Step 1: Write the failing test**

Create `test/recordingsViaProxyDownloads.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { getRecordings, resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, type SimCameraOptions, type SimState } from './camera/sim';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { recordingOf, seedRecordings } from './proxy/seedRecordings';

// Spec 2026-10-02: the clip download of a camera with a cam-proxy. Sub: the
// proxy's recordings, its FTP copy (-proxy.mp4), the camera. Main (4K): the
// proxy's recordings, the camera, else full_quality_unavailable; never the
// FTP copy (Klaus: no silent quality downgrade).
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CLIP = Buffer.from('ftp copy bytes '.repeat(100));

let cam: Server;
let state: SimState;
let fake: FakeProxy;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;

async function startCamera(opts: Partial<SimCameraOptions> = {}) {
  const sim = await createSimCamera({ user: 'u', password: 'p', ...opts });
  state = sim.state;
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  const host = `127.0.0.1:${(cam.address() as AddressInfo).port}`;
  setCameras([
    { id: 'cam1', name: 'Den', host, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } },
    { id: 'porch', name: 'Porch', host, protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetClients();
  resetProxyClients();
  resetRecordings();
}

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-viaproxy-dl-'));
  process.env.CACHE_DIR = cacheDir;
  process.env.RECORDINGS_PROBE_MS = '60000';
  fake = await startFakeProxy();
  await startCamera();
});
afterEach(async () => {
  await new Promise<void>((r) => cam.close(() => r()));
  await fake.stop();
  setCameras([]);
  process.env.CACHE_DIR = workerCacheDir;
  delete process.env.RECORDINGS_PROBE_MS;
  rmSync(cacheDir, { recursive: true, force: true });
});

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
type Day = { events: { id: string; start: string }[] };
const events = async (id = 'cam1') => (await request(createApp()).get(`/api/cameras/${id}/events?date=${today()}`).set('Cookie', auth)).body as Day;
const download = (id: string, quality: 'sub' | 'main', camera = 'cam1') => request(createApp()).get(`/api/cameras/${camera}/clips/${id}/download?quality=${quality}`).set('Cookie', auth);
const fullQuality = async (id: string, camera = 'cam1') => (await request(createApp()).get(`/api/cameras/${camera}/clips/${id}/full-quality`).set('Cookie', auth)).body as { available: boolean };
const ftpCopy = (start: string) => fake.clips.push({ id: 8, cam: 'cam1', start: Date.parse(start) - 1000, end: Date.parse(start) + 30_000, stream: 'sub', events: [], body: CLIP });
const askedFtp = () => fake.requests.some((q) => q.path.endsWith('/clips') || /\/clips\/\d+\.mp4$/.test(q.path));
const fetchedFtp = () => fake.requests.some((q) => /\/clips\/\d+\.mp4$/.test(q.path));

async function seeded() {
  const list = await seedRecordings(fake, 'cam1', today());
  const day = await events();
  return { list, ev: day.events[0] };
}

describe('the clip download through cam-proxy’s recordings', () => {
  it('downloads sub and main from the proxy, named after the camera’s file', async () => {
    const { list, ev } = await seeded();
    const date = `${ev.id.slice(0, 4)}-${ev.id.slice(4, 6)}-${ev.id.slice(6, 8)}`;
    const t = ev.id.slice(9, 15);
    for (const q of ['sub', 'main'] as const) {
      const r = await binary(download(ev.id, q));
      expect(r.status).toBe(200);
      expect(r.headers['content-disposition']).toBe(`attachment; filename="cam1-${date}_${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}-${q}.mp4"`);
      expect(r.headers['content-length']).toBe(String(recordingOf(list, ev.id, q).body.length));
      expect(Buffer.compare(r.body, recordingOf(list, ev.id, q).body)).toBe(0);
    }
    expect(state.downloads).toBe(0);
    expect(getRecordings().downloadsState('cam1')).toBe('proxy-recordings');
  });

  it('a sub download takes the FTP copy (-proxy.mp4) when the proxy’s recordings answer 502', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'timeout' } };
    const r = await binary(download(ev.id, 'sub'));
    expect(r.headers['content-disposition']).toMatch(/-proxy\.mp4"$/);
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    expect(state.downloads).toBe(0);
  });

  // Klaus, 2026-10-02: no silent quality downgrade. Review focus 2: the
  // camera needs the folder of a bare name from the proxy's list.
  it('a 4K download with the proxy failing takes the camera’s main file, never the FTP copy', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const searches = state.searches;
    const r = await binary(download(ev.id, 'main'));
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/-main\.mp4"$/);
    expect(Buffer.compare(r.body, CLIP)).not.toBe(0);
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(1);
    expect(state.searches).toBe(searches + 1);
  });

  it('a 4K download answers full_quality_unavailable when the proxy and the camera both fail, never the FTP copy', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ dropFirstDownloads: 1000 }); // the camera refuses every download
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const r = await download(ev.id, 'main');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'full_quality_unavailable' });
    expect(fetchedFtp()).toBe(false);
    // The standard quality is still there: the FTP copy.
    const sub = await binary(download(ev.id, 'sub'));
    expect(sub.status).toBe(200);
    expect(sub.headers['content-disposition']).toMatch(/-proxy\.mp4"$/);
  });

  it('says whether the full-resolution file can be served now, without a transfer', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ dropFirstDownloads: 1000 });
    const list = await seedRecordings(fake, 'cam1', today());
    const day = await events();
    const ev = day.events[0];
    // The proxy knows the main file (a HEAD, answered from its list).
    expect(await fullQuality(ev.id)).toEqual({ available: true });
    expect(fake.recordingFetches).toEqual([]);
    expect(fake.requests.some((q) => q.path.endsWith(recordingOf(list, ev.id, 'main').id))).toBe(true);
    // The proxy fails: the camera's breaker decides. Closed: available.
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    expect(await fullQuality(ev.id)).toEqual({ available: true });
    // Three refused 4K downloads open the breaker: not available.
    for (const e of day.events.slice(0, 3)) expect((await download(e.id, 'main')).status).toBe(503);
    expect(await fullQuality(ev.id)).toEqual({ available: false });
    // A camera without a cam-proxy: its breaker, as before (closed here).
    const porch = await events('porch');
    expect(await fullQuality(porch.events[0].id, 'porch')).toEqual({ available: true });
  });

  it('answers unknown_clip for a recording gone from the SD card, with no fallback', async () => {
    const { list, ev } = await seeded();
    ftpCopy(ev.start);
    const mainId = recordingOf(list, ev.id, 'main').id;
    fake.recordings.set('cam1', list.filter((r) => r.id !== mainId));
    const r = await download(ev.id, 'main');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'unknown_clip' });
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  it('never tries another route for a viewer who left', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    const before = fake.requests.length;
    const ctl = new AbortController();
    ctl.abort();
    await expect(getRecordings().openDownload('cam1', ev.id, 'sub', ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.requests.length).toBe(before);
    expect(state.downloads).toBe(0);
  });

  // Review focus 5: bytes were already sent, so the response ends short.
  it('ends the response short when the proxy drops mid-transfer, with no fallback', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingDropAfter = 100;
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cameras/cam1/clips/${ev.id}/download?quality=sub`, { headers: { Cookie: auth } });
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    expect(fetchedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  it('leaves a camera without a cam-proxy unchanged: the camera’s download, named -main', async () => {
    const day = await events('porch');
    const r = await download(day.events[0].id, 'main', 'porch');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="porch-.*-main\.mp4"$/);
    expect(state.downloads).toBe(1);
    expect(fake.requests).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project node test/recordingsViaProxyDownloads.test.ts`
Expected: FAIL. The sub download comes from the camera, `recordingFetches` is empty, the `full-quality` route answers 404, and the refused 4K download is served from the FTP copy (`-proxy.mp4`).

- [ ] **Step 3: The error code, HEAD, and `headProxyRecording()`**

In `server/recordings/errors.ts`, widen the code:

```ts
  constructor(readonly code: 'unknown_clip' | 'thumbnail_unavailable' | 'recordings_unavailable' | 'full_quality_unavailable', message: string) {
```

In `server/proxy/client.ts`, line 53, let `open()` send a HEAD:

```ts
    init: { method?: 'GET' | 'HEAD' | 'POST' | 'DELETE'; body?: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number | null; idleMs?: number } = {},
```

Append to `server/recordings/proxyRecordings.ts`:

```ts
// Whether the proxy knows a recording, without a transfer (its HEAD answers
// from the list). Any failure throws a ProxyError: a HEAD has no body, so a
// gone recording and an older proxy's 404 look the same here.
export async function headProxyRecording(cameraId: string, id: string): Promise<void> {
  const client = clientFor(cameraId);
  const res = await client.open(`${base(cameraId)}/${encodeURIComponent(id)}`, undefined, { method: 'HEAD' });
  await res.body?.cancel();
  if (!res.ok) throw new ProxyError('proxy_error', `cam-proxy ${client.host()} answered ${res.status} for a recording`, res.status);
}
```

- [ ] **Step 4: `openDownload()`, `handOver()`, `mainAvailable()`**

In `server/recordings/service.ts`, extend the `proxyRecordings` import with `headProxyRecording`:

```ts
import { fallsBack, headProxyRecording, listProxyDays, listProxyRecordings, logProxyFailure, openProxyRecording, type ProxyRecording } from './proxyRecordings';
```

Delete `proxyClipFor()` and its comment (lines 363-369). Its only caller is the old `openDownload()`.

Replace `openDownload()` and its comment (lines 504-579) with:

```ts
  // The clip download, streamed through (not cached), in the spec 2026-10-02
  // order. Sub: the proxy's recordings API (the camera's own file, so it
  // keeps its -sub name), its FTP copy (-proxy.mp4), then the camera. Main
  // (4K): the proxy's recordings, then the camera; never the FTP copy, which
  // is the sub stream (Klaus, 2026-10-02: no silent quality downgrade), so
  // when both fail it answers full_quality_unavailable and the dialog offers
  // the standard quality. The camera's transfer slot is released once the
  // returned stream closes or fails, and is never left held if `signal`
  // aborts. A viewer who left is never retried on another route; a failure
  // after bytes were sent ends the response short.
  async openDownload(
    cameraId: string,
    clipId: string,
    quality: 'sub' | 'main',
    signal?: AbortSignal,
  ): Promise<{ stream: Readable; filename: string; size: number | null }> {
    const names = await this.names(cameraId, clipId);
    const picked = pickStream(quality, names);
    if (!picked) throw new RecordingError('unknown_clip', 'clip has no file');
    if (signal?.aborted) throw abortError();
    const { name, served } = picked;
    const t = clipId.slice(9, 15);
    const filename = `${cameraId}-${dateOf(clipId)}_${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}-${served}.mp4`;

    const fromSd = await this.viaProxy(cameraId, clipId, () => openProxyRecording(cameraId, baseName(name), signal), signal);
    if (fromSd) return this.handOver(fromSd, filename, () => undefined, signal);
    if (signal?.aborted) throw abortError();

    if (served === 'sub') {
      const ftp = await this.proxyClip(cameraId, clipId);
      if (ftp) {
        try {
          const got = await openProxyClip(cameraId, ftp.id, signal);
          return this.handOver(got, filename.replace(/-sub\.mp4$/, '-proxy.mp4'), () => undefined, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          logger.warn({ cameraId, clipId, message: (err as Error).message }, 'proxy_clip_fetch_failed');
        }
      }
    }

    const slot = this.acquireTransfer(cameraId, signal);
    await slot.ready;
    try {
      const res = await this.downloadWithRetry(cameraId, await this.cameraPath(cameraId, clipId, name, served), signal);
      const cl = res.headers['content-length'];
      return this.handOver({ stream: res, size: typeof cl === 'string' && /^\d+$/.test(cl) ? Number(cl) : null }, filename, slot.release, signal);
    } catch (err) {
      slot.release();
      const final = signal?.aborted || (err instanceof RecordingError && err.code === 'unknown_clip');
      if (served === 'main' && !final) throw new RecordingError('full_quality_unavailable', 'the full-resolution file is not available right now');
      throw err;
    }
  }

  // Calls `release` once the stream closes or fails; an abort that came while
  // the stream was opening destroys it.
  private handOver(
    got: { stream: Readable; size: number | null },
    filename: string,
    release: () => void,
    signal?: AbortSignal,
  ): { stream: Readable; filename: string; size: number | null } {
    let released = false;
    const once = () => {
      if (released) return;
      released = true;
      release();
    };
    got.stream.once('close', once);
    got.stream.once('error', once);
    if (signal?.aborted) {
      got.stream.destroy();
      throw abortError();
    }
    return { stream: got.stream, filename, size: got.size };
  }

  // Whether a 4K (main) download can be served now, without a transfer: the
  // proxy knows the main file, or the camera's download breaker is closed.
  // The Save dialog asks before offering 4K's Save (Klaus, 2026-10-02).
  async mainAvailable(cameraId: string, clipId: string): Promise<boolean> {
    const { main } = await this.names(cameraId, clipId);
    if (!main) return false;
    const known = await this.viaProxy(cameraId, clipId, async () => {
      await headProxyRecording(cameraId, baseName(main));
      return true;
    });
    return known ?? (this.health.get(cameraId)?.failures ?? 0) < BREAKER_FAILURES;
  }
```

- [ ] **Step 5: The route**

In `server/routes/recordings.ts`, after the `/download` route, add:

```ts
// Whether a 4K (main) download can be served now (Klaus, 2026-10-02: no
// silent quality downgrade). The Save dialog asks when 4K is chosen; an
// unknown clip is simply not available.
recordingsRouter.get('/api/cameras/:id/clips/:clipId/full-quality', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  try {
    res.json({ available: await getRecordings().mainAvailable(id, clipId) });
  } catch (err) {
    if (err instanceof RecordingError && err.code === 'unknown_clip') return void res.json({ available: false });
    fail(err, id, res, next);
  }
});
```

- [ ] **Step 6: Update the expectation that changes by design**

In `test/proxyClips.test.ts`, replace the test `'serves the download from the proxy, named as such'` (lines 130-140) with:

```ts
  // Klaus, 2026-10-02: no silent quality downgrade. The camera refuses and
  // the proxy has no SD recordings (503): SD takes the FTP copy, 4K doesn't.
  it('serves the SD download from the proxy’s FTP copy, named as such, but never 4K', async () => {
    const app = createApp();
    const [ev] = (await events(app)).events;
    const start = Date.parse(ev.start);
    fake.clips.push({ id: 7, cam: 'cam1', start: start - 1000, end: start + 30_000, stream: 'main', events: [], body: CLIP });
    const r = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/download?quality=sub`).set('Cookie', auth));
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/-proxy\.mp4"$/);
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    const main = await request(app).get(`/api/cameras/cam1/clips/${ev.id}/download?quality=main`).set('Cookie', auth);
    expect(main.status).toBe(503);
    expect(main.body).toEqual({ error: 'full_quality_unavailable' });
  });
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project node test/recordingsViaProxyDownloads.test.ts test/proxyClips.test.ts test/proxyFirst.test.ts`
Expected: PASS. `proxyFirst.test.ts` is unchanged.

Run: `npm run build && npm test`
Expected: PASS. tsc reports no unused `proxyClipFor`.

- [ ] **Step 8: Commit**

```bash
git add server/recordings/errors.ts server/proxy/client.ts server/recordings/proxyRecordings.ts server/recordings/service.ts server/routes/recordings.ts test/recordingsViaProxyDownloads.test.ts test/proxyClips.test.ts
git commit -m "feat(recordings): clip downloads from cam-proxy's recordings first; 4K never falls back to the FTP copy"
```

---

### Task 6: The source note, the 4K message, and the docs

**Files:**
- Modify: `web/src/lib/dayCache.ts:8`
- Modify: `web/src/lib/dayCache.test.ts`
- Modify: `web/src/pages/Video.svelte:12, 44, 457`
- Modify: `web/src/lib/compose.ts` (adds `fullQualityAvailable()`)
- Modify: `web/src/components/ComposeDialog.svelte` (the 4K message)
- Modify: `web/src/components/ComposeDialog.svelte.test.ts`
- Modify: `e2e/recordings.spec.ts:476-481`
- Modify: `docs/reolink-api.md` ("Where cams handles each quirk" table)
- Modify: `README.md:24, 107`
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:**
- Consumes: Task 3's server values `'ok' | 'proxy-recordings' | 'proxy' | 'unavailable'` in the `downloads` field of `GET /api/cameras/:id/events`; Task 5's `GET /api/cameras/:id/clips/:clipId/full-quality` → `{"available": boolean}`.
- Produces: in `web/src/lib/dayCache.ts`, `export type Downloads = 'ok' | 'proxy-recordings' | 'proxy' | 'unavailable'`, `DayEvents.downloads: Downloads` and `export function sourceLabel(d: Downloads): string`. In `web/src/lib/compose.ts`, `export function fullQualityAvailable(cam: string, clipId: string): Promise<boolean>` (true when unsure). New test ids `compose-4k-unavailable` and `compose-use-sd`.

- [ ] **Step 1: Write the failing test**

In `web/src/lib/dayCache.test.ts`, change the import line to:

```ts
import { dayStore, loadDay, resetDayCache, sourceLabel, type Fetch } from './dayCache';
```

Add inside `describe('dayCache', () => { … })`:

```ts
  it('names the source of recordings for the note under the player', () => {
    expect(sourceLabel('proxy-recordings')).toBe('cam-proxy (SD card)');
    expect(sourceLabel('proxy')).toBe('cam-proxy (FTP copies)');
    expect(sourceLabel('ok')).toBe('camera');
  });
```

In `web/src/components/ComposeDialog.svelte.test.ts`, add inside `describe('ComposeDialog', () => { … })`:

```ts
  // Klaus, 2026-10-02: no silent quality downgrade.
  it('says when the full-resolution file isn’t available, disables 4K’s Save, and offers the standard quality', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/full-quality') ? { available: false } : { available: true }), { status: 200 })));
    render();
    set4k();
    await vi.waitFor(() => expect(q('compose-4k-unavailable')?.textContent).toBe("The full-resolution file isn't available right now; download the standard quality instead."));
    expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('true');
    expect(q('compose-save')!.hasAttribute('href')).toBe(false);
    q('compose-use-sd')!.click();
    flushSync();
    expect((q('compose-size') as HTMLSelectElement).value).toBe('sd');
    expect(q('compose-4k-unavailable')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toMatch(/download\?quality=sub/);
  });

  it('keeps 4K’s Save when the full-resolution file is available', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ available: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render();
    set4k();
    await vi.waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/api/cameras/den/clips/20260928-140000-140020/full-quality'))).toBe(true));
    flushSync();
    expect(q('compose-4k-unavailable')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toMatch(/download\?quality=main/);
  });
```

and, next to the file's other helpers (after `const set = …`):

```ts
const set4k = () => {
  const el = q('compose-size') as HTMLSelectElement;
  el.value = '4k';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
};
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project node web/src/lib/dayCache.test.ts && npx vitest run --project components web/src/components/ComposeDialog.svelte.test.ts`
Expected: FAIL. `sourceLabel is not a function`, and `compose-4k-unavailable` is never shown.

- [ ] **Step 3: Implement**

In `web/src/lib/dayCache.ts`, replace line 8 (`export interface DayEvents { … }`) with:

```ts
// Where a day's recordings come from (server/recordings/service.ts,
// downloadsState): the cam-proxy's recordings API (the SD card), its FTP
// copies when that failed, or the camera; 'unavailable' when a camera without
// a proxy refuses downloads.
export type Downloads = 'ok' | 'proxy-recordings' | 'proxy' | 'unavailable';
export interface DayEvents { events: EventClip[]; downloads: Downloads }

// The note under the player.
export function sourceLabel(d: Downloads): string {
  if (d === 'proxy-recordings') return 'cam-proxy (SD card)';
  if (d === 'proxy') return 'cam-proxy (FTP copies)';
  return 'camera';
}
```

In `web/src/pages/Video.svelte`:
- line 12: `import { loadDay, sourceLabel, type Downloads } from '../lib/dayCache';`
- line 44: `let downloads: Downloads = $state('ok');`
- line 457: `<p class="note" data-testid="recordings-source" role="status">Source of recordings and thumbnails: {sourceLabel(downloads)}</p>`

In `web/src/lib/compose.ts`, after `isAvailable()`, add:

```ts
// Whether a 4K (main) download can be served now (Klaus, 2026-10-02: no
// silent quality downgrade); true when unsure, as the Save itself then tells.
export async function fullQualityAvailable(cam: string, clipId: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/cameras/${encodeURIComponent(cam)}/clips/${encodeURIComponent(clipId)}/full-quality`, { credentials: 'same-origin' });
    const j = (await r.json()) as { available?: unknown };
    return j.available !== false;
  } catch {
    return true;
  }
}
```

In `web/src/components/ComposeDialog.svelte`:
- the `compose` import gains `fullQualityAvailable`:
  `import { cancelJob, composedName, formatLength, fullQualityAvailable, isAvailable, ORIGINAL_4K_LABEL, pollJob, resultLength, SIZE_LABELS, startJob, videoUrl, type ComposeSize, type JobView, type SaveSize } from '../lib/compose';`
- after `const is4k = $derived(size === '4k');`, add:

```ts
  // Whether the full-resolution file can be served now; asked once, when 4K
  // is first chosen. No silent quality downgrade (Klaus, 2026-10-02): when it
  // can't, 4K's Save is off and the standard quality is offered instead.
  let fullOk = $state(true);
  let fullAsked = false;
  $effect(() => {
    if (!is4k || fullAsked) return;
    fullAsked = true;
    void fullQualityAvailable(camera, clip.id).then((a) => (fullOk = a));
  });
  const fullMissing = $derived(is4k && !fullOk);
```

- after the `{#if is4k} … compose-4k-note … {/if}` block, add:

```svelte
  {#if fullMissing}
    <p class="err" data-testid="compose-4k-unavailable" role="status">The full-resolution file isn't available right now; download the standard quality instead.</p>
    <button class="link" data-testid="compose-use-sd" onclick={() => (size = 'sd')}>Download the standard quality</button>
  {/if}
```

- the Save link: no href and `aria-disabled="true"` while the full-resolution file is missing:

```svelte
    <a data-testid="compose-save" class="primary" download
      href={fullMissing ? undefined : plain ? downloadUrl(camera, clip.id, is4k ? 'main' : 'sub') : ready && job ? videoUrl(camera, job.id, false, name) : undefined}
      aria-disabled={!fullMissing && (plain || ready) ? 'false' : 'true'}>Save</a>
```

- in `<style>`, add (colours from the theme tokens):

```css
  .link { align-self: flex-start; padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; font-size: 13px; text-decoration: underline; cursor: pointer; }
```

Check that `--accent` exists in `web/src/styles/theme.css` (`grep -n -- '--accent' web/src/styles/theme.css`). If it doesn't, use the token the app's other text links use (`grep -rn 'text-decoration: underline' web/src/components | head -3`).

In `e2e/recordings.spec.ts`, replace the test `'names the source of recordings and thumbnails: cam-proxy or camera (Klaus, 2026-09-28)'` (lines 476-481) with:

```ts
test('names the source of recordings and thumbnails: cam-proxy or camera (Klaus, 2026-09-28)', async ({ page }) => {
  // Den's fake cam-proxy holds no SD recordings (it answers 503), so cams
  // falls back, and clips would come from the proxy's FTP copies.
  await page.goto('/app/recordings?panel=history&cam=cam1');
  await expect(page.getByTestId('recordings-source')).toHaveText('Source of recordings and thumbnails: cam-proxy (FTP copies)');
  await page.goto('/app/recordings?panel=history&cam=porch');
  await expect(page.getByTestId('recordings-source')).toHaveText('Source of recordings and thumbnails: camera');
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project node web/src/lib/dayCache.test.ts && npx vitest run --project components web/src/components/ComposeDialog.svelte.test.ts && npm run check && npm run check:svelte`
Expected: PASS (the dialog's earlier tests too: their fetch stubs answer `{}` or `available: true`, so 4K stays available); no type errors.

Run: `npm run build && npx playwright test e2e/recordings.spec.ts -g "names the source"`
Expected: PASS (desktop and phone). This runs on a laptop only, never on the self-hosted runner.

- [ ] **Step 5: Docs**

In `docs/reolink-api.md`, in the table under "## Where cams handles each quirk":

Replace the row starting `| One Search at a time (−54) |` with:

```markdown
| One Search at a time (−54); an overlapping Search can also come back empty without an error | `searchGate` in `server/reolink/client.ts`; a camera with a cam-proxy is searched only through the proxy (`day()`, `days()` in `server/recordings/service.ts`), whose one searcher keeps cams' and the proxy's Searches apart | a concurrent Search gets −54 |
```

Replace the row starting `| Camera refuses every Download |` with:

```markdown
| Camera refuses every Download | with a cam-proxy, clips come from its recordings API first (the SD file over Baichuan: `viaProxy()` in `server/recordings/service.ts`, `server/recordings/proxyRecordings.ts`), then its FTP copy (`proxyClip`; playback and SD downloads only, never 4K), then the camera; a 4K download that neither can serve answers `503 full_quality_unavailable`; download-health breaker for the camera (`guard`, `noteRefused`, `probeIfDue`): after `BREAKER_FAILURES` (3) refusals, clip requests get `503 recordings_unavailable`; one probe per `RECORDINGS_PROBE_MS` (default 60 s) | fault `downloads.refuse` (e2e cameras Shed, and Barn with a proxy) |
```

In `README.md`, replace the bullet that starts `  - **Clips first from the proxy:**` (line 24) with:

```markdown
  - **Recordings from the proxy:** History's list, the calendar's days, playback, downloads and the clip-based thumbnails come from the proxy's recordings API: the SD card's files, which the proxy fetches over Baichuan, so any recording of the last 7 days plays and downloads in SD or 4K while the camera refuses HTTP downloads. Every camera Search for such a camera goes through the proxy (the camera answers overlapping Searches with an empty list). When the proxy can't answer (502/503 or unreachable), playback and SD downloads come from its FTP copy (`…-proxy.mp4`), then from the camera's own download behind the breaker, and the list and the calendar from the camera's Search. A 4K download never falls back to the FTP copy (it is the sub stream): it comes from the proxy or the camera, and when neither can serve it the "Save clip" dialog says "The full-resolution file isn't available right now; download the standard quality instead" and offers SD (`GET /api/cameras/:id/clips/:clipId/full-quality`). A recording the proxy reports gone from the SD card answers `unknown_clip`. Downloads from the recordings API keep the camera's `-sub`/`-main` names. The line under the player names the source: cam-proxy (SD card), cam-proxy (FTP copies) or camera.
```

In `README.md`, replace the bullet that starts `- **cam-proxy in tests** is a small fake` (line 107) with:

```markdown
- **cam-proxy in tests** is a small fake (`test/proxy/fakeProxy.ts`) that follows cam-proxy's `openapi.yaml` for the stream, clips, stills, previews and SD recordings. Unit tests set its data directly (`test/proxy/seedRecordings.ts` gives it cam-sim's recordings); e2e runs it as a process, seeded with ffmpeg test patterns (`e2e/fakeProxyData.ts`), without SD recordings (its recordings routes answer 503). The real round trip is checked against cam-proxy in the cluster.
```

In `CHANGELOG.md`, under `## [Unreleased]`, add:

```markdown
- Recordings of a camera with a cam-proxy come from the proxy's recordings API: the SD card's files, fetched over Baichuan, which works while the camera refuses HTTP downloads. Any recording of the last 7 days plays and downloads in SD or 4K again; the proxy's FTP copies and then the camera's own download are the fallbacks. 4K never falls back to the FTP copy (it is SD): when the full-resolution file can't be served, the Save dialog says so and offers the standard quality. The calendar and the day's list come from the proxy too, so cams no longer searches such a camera itself. The line under the player says "cam-proxy (SD card)" or "cam-proxy (FTP copies)".
```

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/dayCache.ts web/src/lib/dayCache.test.ts web/src/pages/Video.svelte web/src/lib/compose.ts web/src/components/ComposeDialog.svelte web/src/components/ComposeDialog.svelte.test.ts e2e/recordings.spec.ts docs/reolink-api.md README.md CHANGELOG.md
git commit -m "feat(web): source note (SD card or FTP copies), the 4K-unavailable message; docs"
```

---

### Task 7: Cross-stack e2e with the real cam-proxy (last)

**This task depends on two releases.** One is a cam-sim release with the Baichuan server (`CAMSIM_BAICHUAN_PORT`). The other is a cam-proxy release that ships the recordings API, plus `camera.baichuanPort` and `/control/status` `recordings`. If Step 1 finds no such cam-proxy release, stop here: Tasks 1-6 can merge on their own, and this task follows in its own PR once the release exists.

cams' e2e has no real cam-proxy today, only the fake on :8095. This task adds one for a new camera, "Silo". Its cam-sim refuses HTTP Download (`downloads.refuse`) and serves Baichuan, and cam-proxy's released container image is pointed at it. The container uses host networking, because cam-sim listens on 127.0.0.1 only. That also makes cam-proxy listen on every interface of the machine, so it runs in CI (an ephemeral GitHub runner) or with `CAMS_E2E_REAL_PROXY=1` on a Linux machine whose network is yours. It never runs on a laptop on the home LAN, where LAN exposure needs Klaus's approval. Elsewhere the spec skips, and Silo behaves like Shed with an unreachable proxy.

**Files:**
- Modify: `package.json`, `package-lock.json` (cam-sim release)
- Modify: `e2e/env.ts` (real-proxy values and the pinned tag)
- Modify: `e2e/sims.ts` (Baichuan ports for every sim; Silo)
- Modify: `e2e/cameras.json` (Silo)
- Create: `e2e/realProxy.ts`
- Modify: `playwright.config.ts`
- Modify: `e2e/shell.spec.ts:14`
- Test: `e2e/realProxy.spec.ts` (create)
- Modify: `README.md` (the e2e cameras list)

**Interfaces:**
- Consumes: Task 6's note text "Source of recordings and thumbnails: cam-proxy (SD card)"; the existing test ids `event-card`, `clip-video`, `event-download`, `compose-size`, `compose-save`; `signIn()` from `e2e/session.ts`.
- Produces (in `e2e/env.ts`): `REAL_PROXY = { port: 8091, go2rtcRtsp: 8092, go2rtcApi: 8089, token: string, adminToken: string }`, `REAL_PROXY_ON: boolean`, `CAM_PROXY_TAG: string`. In `e2e/sims.ts`, `SIMS.silo` and `Sim.baichuan`.

- [ ] **Step 1: Find the releases and pin them**

```bash
TAG=$(gh release view -R klaushofrichter/cam-proxy --json tagName -q .tagName)
echo "$TAG"
gh api "repos/klaushofrichter/cam-proxy/contents/src/api/client-api.ts?ref=$TAG" -q .content | base64 -d | grep -c "/recordings"
```

Expected: a tag like `v2026.10.0X.N`, then a count of 1 or more. A count of 0 means the release with the recordings API isn't out yet: stop, as described above.

```bash
CAMSIM=$(gh api "repos/klaushofrichter/cam-proxy/contents/package.json?ref=$TAG" -q .content | base64 -d | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).devDependencies["cam-sim"]')
echo "$CAMSIM"
npm install -D "$CAMSIM"
grep -rl CAMSIM_BAICHUAN_PORT node_modules/cam-sim/dist | head -1
printf "\n// The cam-proxy release the e2e runs for Silo (e2e/realProxy.ts): the first\n// with the recordings API, or later. Bump it with cam-proxy releases.\nexport const CAM_PROXY_TAG = '%s';\n" "$TAG" >> e2e/env.ts
docker pull "ghcr.io/klaushofrichter/cam-proxy:$TAG"
```

Expected: the cam-sim URL cam-proxy tests against, a successful install, a file path from `grep` (this cam-sim has the Baichuan server), and the image pulled.

Run: `npm test`
Expected: PASS with the new cam-sim. A failure here is a cam-sim change to raise in the cam-sim repo, not something to work around in cams.

- [ ] **Step 2: Real-proxy values in `e2e/env.ts`**

Append to `e2e/env.ts`, after the `CAM_PROXY_TAG` line:

```ts
// The real cam-proxy for Silo (e2e/realProxy.ts). Test-only tokens. It runs
// in CI, or with CAMS_E2E_REAL_PROXY=1 on a Linux machine (host networking:
// it listens on every interface, so never on a laptop on the home LAN).
export const REAL_PROXY = {
  port: 8091,
  go2rtcRtsp: 8092,
  go2rtcApi: 8089,
  token: 'e2e-real-proxy-token-not-a-secret-000000',
  adminToken: 'e2e-real-proxy-admin-not-a-secret-000000',
};
export const REAL_PROXY_ON = !!process.env.CI || process.env.CAMS_E2E_REAL_PROXY === '1';
```

- [ ] **Step 3: Silo and the Baichuan ports in `e2e/sims.ts` and `e2e/cameras.json`**

In `e2e/sims.ts`, change the `Sim` type and `SIMS`:

```ts
type Sim = { http: number; https: number; control: number; onvif: number; rtsp: number; baichuan: number; faults: object[] };
```

```ts
export const SIMS: Record<'den' | 'porch' | 'shed' | 'barn' | 'silo', Sim> = {
  den: { http: 8098, https: 8198, control: 8298, onvif: 8398, rtsp: 8498, baichuan: 8598, faults: [STRICT] },
  // Porch always rejects SetWhiteLed, so settings.spec.ts can exercise a
  // partial save without making Den unreliable for the live specs.
  porch: { http: 8097, https: 8197, control: 8297, onvif: 8397, rtsp: 8497, baichuan: 8597, faults: [STRICT, { name: 'settings.fail', cmds: ['SetWhiteLed'] }] },
  // Shed refuses every recording download, like the real RLC-1224A since
  // 2026-09-26 (Plan 5 breaker and banner).
  shed: { http: 8096, https: 8196, control: 8296, onvif: 8396, rtsp: 8496, baichuan: 8596, faults: [STRICT, { name: 'downloads.refuse' }] },
  // Barn refuses downloads too, but has a cam-proxy (Plan 6, the fake in
  // test/proxy/fakeProxy.ts) whose clip plays instead; its live stream always
  // resets, so Live shows the gateway's stills (Plan 7).
  barn: { http: 8094, https: 8194, control: 8294, onvif: 8394, rtsp: 8494, baichuan: 8594, faults: [STRICT, { name: 'downloads.refuse' }, { name: 'flv.reset' }] },
  // Silo refuses HTTP Download like the real camera since 2026-10-01, and has
  // the real cam-proxy (e2e/realProxy.ts), which fetches its recordings over
  // Baichuan (spec 2026-10-02-recordings-via-proxy-design).
  silo: { http: 8090, https: 8190, control: 8290, onvif: 8390, rtsp: 8490, baichuan: 8590, faults: [STRICT, { name: 'downloads.refuse' }] },
};
```

In `simEnv()`, after `CAMSIM_RTSP_PORT: String(s.rtsp),`, add:

```ts
    // cam-sim's Baichuan server (port 9000 by default); five simulators on one
    // machine need their own ports.
    CAMSIM_BAICHUAN_PORT: String(s.baichuan),
```

In `e2e/cameras.json`, add a last entry (after Barn's line, which gains a comma):

```json
  {"id": "silo", "name": "Silo", "host": "127.0.0.1:8090", "protocol": "http", "user": "e2e", "password": "e2e-not-a-real-password", "webUiNote": "Website not available - simulated camera", "proxy": {"url": "http://127.0.0.1:8091", "token": "e2e-real-proxy-token-not-a-secret-000000"}}
```

In `e2e/shell.spec.ts`, line 14:

```ts
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Den', 'Garage', 'Porch', 'Shed', 'Barn', 'Silo']);
```

- [ ] **Step 4: Write the failing e2e test**

Create `e2e/realProxy.spec.ts`:

```ts
import { readFileSync } from 'fs';
import { expect, test, type Page } from '@playwright/test';
import { REAL_PROXY, REAL_PROXY_ON } from './env';
import { signIn } from './session';

// Across the stack (spec 2026-10-02-recordings-via-proxy-design): Silo's
// cam-sim refuses HTTP Download, the real cam-proxy fetches the SD recording
// over Baichuan, and cams plays it and saves it in 4K (the main stream).
test.skip(!REAL_PROXY_ON, 'needs the real cam-proxy: CI, or CAMS_E2E_REAL_PROXY=1 on Linux (e2e/env.ts)');

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const card = (page: Page, hhmmss: string) => page.locator(`[data-testid="event-card"][data-clip-id*="-${hhmmss}-"]`);

test('Silo plays and saves a recording its camera refuses over HTTP', async ({ page }) => {
  await page.goto('/app/recordings?cam=silo&panel=events');
  await expect(page.getByTestId('event-card')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.getByTestId('recordings-source')).toHaveText('Source of recordings and thumbnails: cam-proxy (SD card)');
  await card(page, '120505').click();
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 30_000 }).toBe(true);
  await page.locator('li', { has: card(page, '120505') }).getByTestId('event-download').click();
  await page.getByTestId('compose-size').selectOption('4k');
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('compose-save').click()]);
  expect(file.suggestedFilename()).toMatch(/^silo-\d{4}-\d{2}-\d{2}_12-05-05-main\.mp4$/);
  const bytes = readFileSync((await file.path())!);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  // The proxy fetched over Baichuan: its HTTP Download is refused.
  const status = (await (await page.request.get(`http://127.0.0.1:${REAL_PROXY.port}/control/status`, { headers: { Authorization: `Bearer ${REAL_PROXY.adminToken}` } })).json()) as { recordings: { last: { result: string } | null } };
  expect(status.recordings.last?.result).toBe('ok');
});
```

- [ ] **Step 5: Run it to make sure it fails**

Run (Linux with Docker, or leave it to CI): `npm run build && CAMS_E2E_REAL_PROXY=1 npx playwright test e2e/realProxy.spec.ts --project desktop`
Expected: FAIL. Nothing serves `127.0.0.1:8091`, so cams falls back: the note reads "cam-proxy (FTP copies)" and the 4K save fails, because Silo refuses HTTP Download and there's no FTP copy.

- [ ] **Step 6: Start the real cam-proxy**

Create `e2e/realProxy.ts`:

```ts
// e2e: the real cam-proxy (its released container image, CAM_PROXY_TAG) for
// Silo, whose cam-sim refuses HTTP Download: the proxy fetches recordings
// over Baichuan (spec 2026-10-02-recordings-via-proxy-design). Host
// networking, because cam-sim listens on 127.0.0.1 only; the proxy then
// listens on every interface, so this runs in CI or on a Linux machine you
// control (REAL_PROXY_ON in e2e/env.ts), never on the home LAN.
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CAM_PROXY_TAG, REAL_PROXY } from './env';
import { SIMS } from './sims';

const NAME = 'cams-e2e-cam-proxy';
const IMAGE = `ghcr.io/klaushofrichter/cam-proxy:${CAM_PROXY_TAG}`;
const s = SIMS.silo;
const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-camproxy-'));
writeFileSync(
  join(dir, 'config.json'),
  JSON.stringify({
    server: { port: REAL_PROXY.port, dataDir: '/data', logLevel: 'warn' },
    camera: { id: 'silo', name: 'Silo', host: `127.0.0.1:${s.http}`, protocol: 'http', user: 'e2e', onvifPort: s.onvif, rtspPort: s.rtsp, baichuanPort: s.baichuan, statusPollS: 5 },
    go2rtc: { rtspPort: REAL_PROXY.go2rtcRtsp, apiPort: REAL_PROXY.go2rtcApi },
    stills: { enabled: false },
    ftp: { enabled: false },
  }),
);

spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }); // one left over from an earlier run
const child = spawn(
  'docker',
  [
    'run', '--rm', '--name', NAME, '--network', 'host',
    // The data folder belongs to the runner's user, not the image's uid 1000.
    '--user', `${process.getuid!()}:${process.getgid!()}`,
    '-v', `${dir}:/data`,
    '-e', 'CAMPROXY_CONFIG=/data/config.json',
    '-e', `CAMPROXY_TOKENS=${REAL_PROXY.token}`,
    '-e', `CAMPROXY_ADMIN_TOKEN=${REAL_PROXY.adminToken}`,
    '-e', 'CAMPROXY_CAMERA_PASSWORD=e2e-not-a-real-password',
    IMAGE,
  ],
  { stdio: 'inherit' },
);
const stop = () => {
  spawnSync('docker', ['stop', '-t', '5', NAME], { stdio: 'ignore' });
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 1));
```

In `playwright.config.ts`, change the env import to:

```ts
import { E2E_ENV, E2E_PORT, REAL_PROXY, REAL_PROXY_ON } from './e2e/env';
```

Replace the `webServer` comment's first sentences ("Four cam-sim cameras … Den and Barn have a fake cam-proxy.") with:

```ts
  // Requires `npm run build` first. Five cam-sim cameras (e2e/sims.ts) stand
  // in for Reolinks: Den, Porch (rejects SetWhiteLed), Shed (refuses
  // downloads), Barn (refuses downloads, live always resets) and Silo
  // (refuses HTTP downloads; the real cam-proxy fetches over Baichuan);
  // e2e/cameras.json points at them, and "Garage" is deliberately
  // unreachable. Den and Barn have the fake cam-proxy; Silo the real one, in
  // CI only (e2e/realProxy.ts).
```

Add after the fake cam-proxy's entry in `webServer`:

```ts
    // The real cam-proxy for Silo (released image; CI, see e2e/realProxy.ts).
    // The first run pulls the image.
    ...(REAL_PROXY_ON ? [{ command: 'npx tsx e2e/realProxy.ts', url: `http://127.0.0.1:${REAL_PROXY.port}/health`, timeout: 300_000, reuseExistingServer: false }] : []),
```

- [ ] **Step 7: Run it to make sure it passes**

Run (Linux with Docker): `npm run build && CAMS_E2E_REAL_PROXY=1 npx playwright test e2e/realProxy.spec.ts`
Expected: PASS (desktop and phone).

On macOS, run the rest of the suite instead. It must stay green with Silo present and the real-proxy spec skipped:
Run: `npm run build && npm run test:e2e`
Expected: PASS, with `realProxy.spec.ts` skipped.

- [ ] **Step 8: README**

In `README.md`, in the e2e cameras list (lines 101-106), replace the line `  - "Barn", which refuses downloads too but has a cam-proxy whose clip plays, and whose live stream always resets, so Live shows the proxy's stills.` with:

```markdown
  - "Barn", which refuses downloads too but has a cam-proxy whose clip plays, and whose live stream always resets, so Live shows the proxy's stills;
  - "Silo", which refuses HTTP downloads like the real camera since 2026-10-01 and has the real cam-proxy (its released container image, pinned in `e2e/env.ts` as `CAM_PROXY_TAG`), which fetches the recordings over Baichuan. It runs in CI only (`e2e/realProxy.ts`: host networking, so it listens on every interface), or with `CAMS_E2E_REAL_PROXY=1` on a Linux machine you control; elsewhere `e2e/realProxy.spec.ts` is skipped.
```

- [ ] **Step 9: Commit and let CI run it**

```bash
git add package.json package-lock.json e2e/env.ts e2e/sims.ts e2e/cameras.json e2e/realProxy.ts e2e/realProxy.spec.ts playwright.config.ts e2e/shell.spec.ts README.md
git commit -m "test(e2e): Silo plays and saves through the real cam-proxy over Baichuan"
git push
```

Expected: in the PR, the `e2e` job (`.github/workflows/production-checks.yml`, GitHub-hosted) runs `realProxy.spec.ts` and passes. Merge only when every check passes.

---

## Self-review (done while writing; kept for the reviewer)

- **Spec coverage:** day list via the proxy, sub then main, `from`/`to` from `timeInfo()` (Task 3). Month list via the proxy, with `extent.ts` following (Task 3). Playback order and the out-of-slot rule (Task 4). Download order, filenames, mid-stream end (Task 5). Thumbnails: still first, then the clip (Task 4). 404 is final, abort never falls back (Tasks 2, 4, 5). Breaker untouched by proxy failures (`viaProxy` never calls `noteRefused`). `downloadsState` with all three transitions (Tasks 3-5). The web types and the note (Task 6). Docs and CHANGELOG (Task 6). The fake's routes against cam-proxy's shapes (Task 1). The cross-stack e2e (Task 7). Logging at warn/error without a token (Task 2).
- **Spec points this plan reads in one particular way:**
  - The month list goes through the proxy, with the camera's month Search only as the fallback (the spec's "Out of scope" line saying otherwise was removed).
  - Klaus's ruling (2026-10-02): a 4K download never falls back to the sub-stream FTP copy. The order is proxy recordings, then the camera, then `full_quality_unavailable`, with the dialog message and the SD offer (Tasks 5 and 6; the spec was updated to match). `test/proxyClips.test.ts` changes on purpose: its 4K download took the FTP copy.
- **Placeholders:** none. Task 7's tag comes from a command in its Step 1, because the release doesn't exist yet.
- **Type consistency:** `listProxyRecordings(cameraId, from, to, stream)`, `listProxyDays(cameraId, month)`, `openProxyRecording(cameraId, id, signal?)`, `fallsBack(err, signal?)`, `logProxyFailure(cameraId, what, err)`, `viaProxy(cameraId, what, ask, signal?)`, `cameraPath(cameraId, clipId, name, stream)`, `handOver(got, filename, release, signal?)`, `seedRecordings(fake, cameraId, date, body?)` and `recordingOf(list, clipId, stream)` are used with these signatures throughout. `DownloadsState` (server) and `Downloads` (web) hold the same four values.

## After the plan (not tasks for the implementer)

- **Order:** cam-sim's Baichuan release, then cam-proxy's recordings API release, then this. Tasks 1-6 work with any cam-proxy (an older one falls back), so their PR can merge before cam-proxy's release; Task 7 waits for it.
- **The Pi:** after cam-proxy's release, `docker compose pull && docker compose up -d` there, then check `/control/status` for "Recordings: ok" after one download.
- **Live check on cam1** (after cams is deployed): a History day shows "cam-proxy (SD card)". A clip from a time FTP missed plays, and its 4K download saves a `-main.mp4`.
- **Release:** Klaus deploys through the `main` → `production` PR (deploy-production.yml moves CHANGELOG's Unreleased into the release notes and clears it; branch after that commit).
- **Notes:** update the Obsidian vault `general-2026`, folder *Cameras* (recordings now come over Baichuan through cam-proxy), and the *Cluster* notes through the kube-setup session if anything there names the FTP path as the source.
- **Minors** from the reviews go into a GitHub issue before the branch is deleted.
