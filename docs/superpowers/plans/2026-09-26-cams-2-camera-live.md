# cams Plan 2: Camera Client and Live Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Live page shows real video from the selected camera: about 1 s of latency, sub/HD quality, snapshot, mute and fullscreen. It reconnects seamlessly across the cluster's 10-minute response limit and shows a clear offline state when a camera can't be reached.

**Architecture:**
- The server talks to each camera over its HTTPS API through a new `ReolinkClient`. The client caches the login token, re-logs in once on auth errors, uses timeouts, allows at most 2 concurrent API calls, and backs off from failed logins.
- The server proxies three things to the signed-in browser: the camera's FLV live stream, snapshots, and a status endpoint. The camera's token never leaves the server.
- The browser plays the stream with mpegts.js through two `<video>` elements. The 9-minute swap and the retry backoff live in a framework-free `LiveSession` class, so they can be unit-tested.
- A mock Reolink camera stands in for the real one in unit tests and e2e.

**Tech Stack:** as in Plan 1, plus `mpegts.js` (frontend, bundled by Vite). Camera requests use Node's built-in `node:https`/`node:http`, which gives an exact certificate-name check (`servername`) without a new dependency. The e2e suite runs in branded Chrome (`channel: 'chrome'`) because Playwright's bundled Chromium has no H.264 decoder.

**Spec:** `docs/superpowers/specs/2026-09-25-cams-design.md` (§2 camera facts, §3 media paths and Reolink client, §5 Live page, §6 errors, §7 mock camera, §11 open checks)

**Follow-ups carried in from Plan 1:** `docs/superpowers/plans/2026-09-25-cams-1-followups.md`. Task 8 takes the CHANGELOG reset item; everything else stays there.

## Camera facts this plan relies on (measured 2026-09-26, fw v3.2.0.6011)

- `POST /cgi-bin/api.cgi?cmd=Login` with body `[{"cmd":"Login","action":0,"param":{"User":{"Version":"0","userName":…,"password":…}}}]` → `value.Token.name` and `leaseTime: 3600` (seconds).
- Other commands: `POST /cgi-bin/api.cgi?cmd=<Cmd>&token=<t>` with the body `[{"cmd":…,"action":0,"param":{…}}]`. On success, `[0].code === 0` and the payload is in `[0].value`. On an invalid or expired token, `[0].code !== 0` and `[0].error.rspCode === -6`.
- `GetDevInfo` → `value.DevInfo.{model, firmVer, name}`. `GetUser` → `value.User[]` of `{userName, level}`.
- Snapshot: `GET /cgi-bin/api.cgi?cmd=Snap&channel=0&rs=<random>&token=<t>` → `image/jpeg`.
- Live: `GET /flv?port=1935&app=bcs&stream=channel0_<sub|main>.bcs&token=<t>` → `video/x-flv`, unending. `sub` is H.264 896×512 + AAC. `main` is H.265 in FLV with legacy codec id 12 (mpegts.js 1.8 decodes it; the browser must support HEVC) + AAC. RTMP must be enabled on the camera (it is).
- The camera serves a valid Let's Encrypt certificate for `cam1.skylar.technology`. Connect by IP with `servername: 'cam1.skylar.technology'` and verify.

## Global Constraints

- Everything from Plan 1's Global Constraints still applies: Node 26, action pins, versioning, `/health` independent of cameras, cookie rules, the allow-list, `trust proxy`, non-root container, JSON logs, tokens, the breakpoint and the commit trailer.
- **Never log** camera passwords, camera tokens, or full camera URLs that contain `token=`. Log only `{cameraId, code, message}`, where `message` never contains a URL query.
- **The camera token never reaches the browser.** All camera traffic is proxied: `/api/cameras/:id/status`, `/api/cameras/:id/snapshot.jpg` and `/api/cameras/:id/live`.
- **Camera access limits.** At most **2** concurrent API requests per camera, and at most **4** concurrent live streams per camera (more → `503 {"error":"too_many_streams"}`). After a failed login, at most 1 login per **30 s** per camera.
- **Token renewal.** Renew the token when fewer than **60 s** of its lease remain.
- **Camera timeouts.** Each camera request has an inactivity timeout of **10 s**.
- **Error responses.** Camera errors map to `503 {"error":"camera_offline"}` (unreachable or timed out), `503 {"error":"camera_auth_failed"}` (login rejected) and `502 {"error":"camera_error"}` (any other camera failure). An unknown camera id is `404 {"error":"unknown_camera"}`.
- **Live player.** The player swaps to a fresh connection every **9 minutes** (Knative cuts responses at 600 s). Reconnect backoff is `min(30 s, 1 s × 2^attempt)`. Audio starts **muted**.
- **HD option.** HD is offered only when `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"')` is true. The quality choice is remembered in `localStorage` under `cams-live-quality`.
- **Registry entries** gain an optional `protocol` (`"https"` default, or `"http"`, used by the mock camera) and an optional `tlsServername`. When `tlsServername` is set, the certificate is verified against it. When it isn't, verification is off and a warning is logged once per camera.

## Review Focus

1. **The camera is unreachable while a user watches.** The player must show "Reconnecting…", retry with backoff, and recover on its own when the camera returns. It must not freeze silently or spin a tight retry loop. Pinned in Task 5 (`LiveSession` tests).
2. **A browser tab closes mid-stream.** The server must abort the upstream camera connection and release the live-stream slot. Otherwise 4 closed tabs lock everyone out with `too_many_streams`. Pinned in Task 4.
3. **The camera token expires or the camera reboots**, which invalidates the token. The next request must re-login transparently, once. A wrong password must not trigger a login storm. Pinned in Task 3.
4. **Switching cameras or quality** must tear down the previous stream, both server and client side, before starting the new one. Watching a sequence of streams must not leak connections. Pinned in Tasks 5 and 6.
5. **Camera or network errors must not leak camera details** (IP, token, password) to the browser or the logs. The client sees only the error codes. Pinned in Tasks 3 and 4.

---

### Task 1: Registry fields for protocol and certificate name

**Files:**
- Modify: `server/cameraRegistry.ts`
- Test: `test/cameraRegistry.test.ts`

**Interfaces:**
- Produces: `CameraConfig` gains `protocol: 'https' | 'http'` (always set; default `'https'`) and `tlsServername?: string`.

- [ ] **Step 1: Update the tests**

In `test/cameraRegistry.test.ts`, change the "loads a valid list" test to expect the default protocol, and add these cases inside `describe('loadCameras', …)`:
```ts
  it('loads a valid list, defaulting protocol to https', () => {
    expect(loadCameras(file('ok.json', JSON.stringify([cam1])))).toEqual([{ ...cam1, protocol: 'https' }]);
  });

  it('keeps protocol http and a tlsServername', () => {
    const entry = { ...cam1, protocol: 'http', tlsServername: 'cam1.example.test' };
    expect(loadCameras(file('extra.json', JSON.stringify([entry])))).toEqual([entry]);
  });

  it('rejects an unknown protocol', () => {
    expect(() => loadCameras(file('proto.json', JSON.stringify([{ ...cam1, protocol: 'ftp' }])))).toThrow(/entry 0.*protocol/);
  });

  it('rejects an empty tlsServername', () => {
    expect(() => loadCameras(file('sni.json', JSON.stringify([{ ...cam1, tlsServername: '' }])))).toThrow(/entry 0.*tlsServername/);
  });
```
Delete the old `it('loads a valid list', …)` it replaces. In `describe('listCameras / getCamera', …)`, change `setCameras([cam1])` to `setCameras([{ ...cam1, protocol: 'https' }])` and the `getCamera` expectation to `{ ...cam1, protocol: 'https' }`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/cameraRegistry.test.ts`
Expected: FAIL (no `protocol` in the output; protocol/tlsServername not validated).

- [ ] **Step 3: Implement**

In `server/cameraRegistry.ts`, replace the `CameraConfig` interface with:
```ts
export interface CameraConfig {
  id: string;
  name: string;
  host: string; // IP or hostname, optionally with :port
  protocol: 'https' | 'http';
  // When set, the camera's TLS certificate is verified against this name
  // (the camera is reached by IP, but its certificate is for a hostname).
  tlsServername?: string;
  user: string;
  password: string;
}
```
Replace the final `return { … } as CameraConfig;` line in `loadCameras` with:
```ts
    if (e.protocol !== undefined && e.protocol !== 'https' && e.protocol !== 'http') {
      throw new Error(`camera registry entry ${i}: protocol must be "https" or "http"`);
    }
    if (e.tlsServername !== undefined && (typeof e.tlsServername !== 'string' || e.tlsServername.length === 0)) {
      throw new Error(`camera registry entry ${i}: tlsServername must be a non-empty string`);
    }
    const camera: CameraConfig = {
      id: e.id as string,
      name: e.name as string,
      host: e.host as string,
      protocol: (e.protocol as 'https' | 'http' | undefined) ?? 'https',
      user: e.user as string,
      password: e.password as string,
    };
    if (e.tlsServername !== undefined) camera.tlsServername = e.tlsServername as string;
    return camera;
```

Update `test/api.test.ts`: every object passed to `setCameras` gains `protocol: 'https'`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: all pass, pristine output.

- [ ] **Step 5: Commit**

```bash
git add server/cameraRegistry.ts test/cameraRegistry.test.ts test/api.test.ts
git commit -m "feat: camera registry protocol and tlsServername"
```

---

### Task 2: Mock Reolink camera

**Files:**
- Create: `test/mock-camera/server.ts`, `test/mock-camera/cli.ts`, `scripts/gen-mock-fixtures.sh`
- Generate and commit: `test/mock-camera/fixtures/live.flv`, `test/mock-camera/fixtures/snapshot.jpg`
- Test: `test/mockCamera.test.ts`

**Interfaces:**
- Produces:
  - `createMockCamera(opts: MockCameraOptions): MockCamera`, where `MockCamera = { app: Express; state: MockState }` and `MockState = { logins: number; activeStreams: number; revokeTokens(): void; offline: boolean }`.
  - `MockCameraOptions = { user: string; password: string; model?: string; firmware?: string }`.
  - The CLI listens on `MOCK_CAMERA_PORT` (default `8098`).

- [ ] **Step 1: Generate the fixtures**

`scripts/gen-mock-fixtures.sh`:
```bash
#!/usr/bin/env bash
# Regenerates the mock camera's media fixtures with ffmpeg: synthetic test
# pattern and tone, no real footage. Outputs are committed; CI never runs this.
set -euo pipefail
dir=test/mock-camera/fixtures
mkdir -p "$dir"
ffmpeg -v error -y -f lavfi -i testsrc=size=320x180:rate=10 -f lavfi -i sine=frequency=440:sample_rate=16000 \
  -t 20 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 10 -c:a aac -b:a 32k -f flv "$dir/live.flv"
ffmpeg -v error -y -f lavfi -i testsrc=size=320x180 -frames:v 1 "$dir/snapshot.jpg"
ls -l "$dir"
```
Run: `bash scripts/gen-mock-fixtures.sh`
Expected: `live.flv` (roughly 100–400 KB) and `snapshot.jpg` (a few KB). Check with `ffprobe -v error -show_entries stream=codec_name -of csv=p=0 test/mock-camera/fixtures/live.flv`, which should print `h264` and `aac`.

- [ ] **Step 2: Write the failing test `test/mockCamera.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createMockCamera } from './mock-camera/server';

const creds = { user: 'u', password: 'p' };
const login = (app: Parameters<typeof request>[0], password = 'p') =>
  request(app)
    .post('/cgi-bin/api.cgi?cmd=Login')
    .send([{ cmd: 'Login', action: 0, param: { User: { Version: '0', userName: 'u', password } } }]);

describe('mock camera', () => {
  it('issues a token for valid credentials and rejects bad ones', async () => {
    const { app } = createMockCamera(creds);
    const ok = await login(app);
    expect(ok.body[0].code).toBe(0);
    expect(ok.body[0].value.Token).toMatchObject({ leaseTime: 3600 });
    const bad = await login(app, 'wrong');
    expect(bad.body[0].code).not.toBe(0);
  });

  it('answers commands only with a valid token', async () => {
    const { app, state } = createMockCamera(creds);
    const token = (await login(app)).body[0].value.Token.name;
    const cmd = (t: string) =>
      request(app).post(`/cgi-bin/api.cgi?cmd=GetDevInfo&token=${t}`).send([{ cmd: 'GetDevInfo', action: 0, param: {} }]);
    expect((await cmd(token)).body[0].value.DevInfo.model).toBe('RLC-1224A');
    expect((await cmd('nope')).body[0].error.rspCode).toBe(-6);
    state.revokeTokens();
    expect((await cmd(token)).body[0].error.rspCode).toBe(-6);
  });

  it('serves a JPEG snapshot with a valid token', async () => {
    const { app } = createMockCamera(creds);
    const token = (await login(app)).body[0].value.Token.name;
    const res = await request(app).get(`/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=x&token=${token}`);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('refuses all requests while "offline"', async () => {
    const { app, state } = createMockCamera(creds);
    state.offline = true;
    const res = await login(app);
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run test/mockCamera.test.ts`
Expected: FAIL, `Cannot find module './mock-camera/server'`.

- [ ] **Step 4: Implement**

`test/mock-camera/server.ts`:
```ts
import express, { Express, Request, Response } from 'express';
import { createReadStream } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

// A stand-in for a Reolink camera's HTTP API, just enough for cams' client:
// Login/Logout, GetDevInfo, Snap and the FLV live endpoint. Used by unit tests
// and by the e2e suite; tests never touch a real camera.
export interface MockCameraOptions {
  user: string;
  password: string;
  model?: string;
  firmware?: string;
}

export interface MockState {
  logins: number;
  activeStreams: number;
  offline: boolean;
  revokeTokens(): void;
}

export interface MockCamera {
  app: Express;
  state: MockState;
}

const FIXTURES = join(__dirname, 'fixtures');
const notLoggedIn = (cmd: string) => [{ cmd, code: 1, error: { detail: 'please login first', rspCode: -6 } }];

export function createMockCamera(opts: MockCameraOptions): MockCamera {
  const tokens = new Set<string>();
  const state: MockState = {
    logins: 0,
    activeStreams: 0,
    offline: false,
    revokeTokens: () => tokens.clear(),
  };
  const app = express();
  app.use((_req, res, next) => (state.offline ? res.status(503).end() : next()));
  app.use(express.json());

  const valid = (req: Request) => typeof req.query.token === 'string' && tokens.has(req.query.token);

  app.post('/cgi-bin/api.cgi', (req: Request, res: Response) => {
    const cmd = String(req.query.cmd ?? '');
    const param = Array.isArray(req.body) ? req.body[0]?.param : undefined;
    if (cmd === 'Login') {
      const u = param?.User;
      if (u?.userName !== opts.user || u?.password !== opts.password) {
        res.json([{ cmd, code: 1, error: { detail: 'login failed', rspCode: -7 } }]);
        return;
      }
      state.logins++;
      const name = randomBytes(8).toString('hex');
      tokens.add(name);
      res.json([{ cmd, code: 0, value: { Token: { leaseTime: 3600, name } } }]);
      return;
    }
    if (!valid(req)) {
      res.json(notLoggedIn(cmd));
      return;
    }
    if (cmd === 'Logout') {
      tokens.delete(String(req.query.token));
      res.json([{ cmd, code: 0, value: { rspCode: 200 } }]);
      return;
    }
    if (cmd === 'GetDevInfo') {
      res.json([
        {
          cmd,
          code: 0,
          value: { DevInfo: { model: opts.model ?? 'RLC-1224A', firmVer: opts.firmware ?? 'v3.2.0.6011_mock', name: 'Mock' } },
        },
      ]);
      return;
    }
    res.json([{ cmd, code: 1, error: { detail: 'not supported by mock', rspCode: -9 } }]);
  });

  app.get('/cgi-bin/api.cgi', (req: Request, res: Response) => {
    if (req.query.cmd !== 'Snap' || !valid(req)) {
      res.json(notLoggedIn(String(req.query.cmd ?? '')));
      return;
    }
    res.type('image/jpeg').sendFile(join(FIXTURES, 'snapshot.jpg'));
  });

  // Streams the fixture once and then keeps the connection open, like a live
  // camera that never ends a stream on its own.
  app.get('/flv', (req: Request, res: Response) => {
    if (!valid(req)) {
      res.status(403).end();
      return;
    }
    state.activeStreams++;
    res.on('close', () => {
      state.activeStreams--;
    });
    res.status(200).type('video/x-flv');
    createReadStream(join(FIXTURES, 'live.flv')).pipe(res, { end: false });
  });

  return { app, state };
}
```

`test/mock-camera/cli.ts`:
```ts
import { createMockCamera } from './server';

// Started by Playwright (playwright.config.ts) for the e2e suite. The
// credentials match e2e/cameras.json; they are not real.
const port = Number(process.env.MOCK_CAMERA_PORT ?? 8098);
createMockCamera({ user: 'e2e', password: 'e2e-not-a-real-password' }).app.listen(port, () => {
  console.log(`mock camera listening on ${port}`);
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run`
Expected: all pass, pristine output.

- [ ] **Step 6: Commit**

```bash
git add test/mock-camera test/mockCamera.test.ts scripts/gen-mock-fixtures.sh
git commit -m "test: mock Reolink camera with synthetic fixtures"
```

---

### Task 3: ReolinkClient

**Files:**
- Create: `server/reolink/http.ts`, `server/reolink/semaphore.ts`, `server/reolink/client.ts`, `server/reolink/clients.ts`
- Test: `test/reolinkClient.test.ts`

**Interfaces:**
- Consumes: `CameraConfig` (Task 1), `createMockCamera` (Task 2, tests only), `logger` (Plan 1).
- Produces:
  - `CameraErrorCode = 'camera_offline' | 'camera_auth_failed' | 'camera_error'`
  - `class CameraError extends Error { code: CameraErrorCode }`
  - `CameraStatus = { model: string; firmware: string }`
  - `class ReolinkClient` with:
    - `constructor(cam: CameraConfig, opts?: { timeoutMs?: number; maxConcurrent?: number; now?: () => number })`
    - `command<T>(cmd: string, param?: object): Promise<T>`
    - `status(): Promise<CameraStatus>`
    - `snapshot(): Promise<Buffer>`
    - `openLive(quality: 'sub' | 'main', signal: AbortSignal): Promise<IncomingMessage>`
  - `getClient(id: string): ReolinkClient | undefined` and `resetClients(): void` (tests)
  - `class Semaphore` with `run<T>(fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing test `test/reolinkClient.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { createMockCamera, MockState } from './mock-camera/server';
import { CameraError, ReolinkClient } from '../server/reolink/client';
import { Semaphore } from '../server/reolink/semaphore';
import type { CameraConfig } from '../server/cameraRegistry';

let server: Server;
let state: MockState;
let cam: CameraConfig;

beforeEach(async () => {
  const mock = createMockCamera({ user: 'u', password: 'p' });
  state = mock.state;
  server = mock.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  cam = { id: 'cam1', name: 'Den', host: `127.0.0.1:${(server.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' };
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('ReolinkClient', () => {
  it('logs in once and reuses the token', async () => {
    const client = new ReolinkClient(cam);
    expect(await client.status()).toEqual({ model: 'RLC-1224A', firmware: 'v3.2.0.6011_mock' });
    await client.status();
    await client.status();
    expect(state.logins).toBe(1);
  });

  it('shares one login between concurrent first requests', async () => {
    const client = new ReolinkClient(cam);
    await Promise.all([client.status(), client.status(), client.status()]);
    expect(state.logins).toBe(1);
  });

  // Review focus 3: expired/invalidated token -> one transparent re-login.
  it('re-logs in once when the camera rejects the token', async () => {
    const client = new ReolinkClient(cam);
    await client.status();
    state.revokeTokens();
    expect((await client.status()).model).toBe('RLC-1224A');
    expect(state.logins).toBe(2);
  });

  it('renews the token before its lease runs out', async () => {
    let now = 1_000_000;
    const client = new ReolinkClient(cam, { now: () => now });
    await client.status();
    now += (3600 - 30) * 1000; // inside the 60 s renewal margin
    await client.status();
    expect(state.logins).toBe(2);
  });

  // Review focus 3: a wrong password must not cause a login storm.
  it('reports camera_auth_failed and backs off after a rejected login', async () => {
    let now = 1_000_000;
    const client = new ReolinkClient({ ...cam, password: 'wrong' }, { now: () => now });
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
    expect(state.logins).toBe(0);
    now += 31_000;
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
  });

  it('reports camera_offline for an unreachable camera without leaking credentials', async () => {
    const client = new ReolinkClient({ ...cam, host: '127.0.0.1:9', password: 'hunter2-not-leaked' }, { timeoutMs: 1000 });
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).code).toBe('camera_offline');
    expect((err as CameraError).message).not.toMatch(/hunter2|127\.0\.0\.1|token=/);
  });

  it('reports camera_offline when the camera answers 503', async () => {
    const client = new ReolinkClient(cam);
    state.offline = true;
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_offline' });
  });

  it('fetches a JPEG snapshot', async () => {
    const snap = await new ReolinkClient(cam).snapshot();
    expect(snap.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('opens a live FLV stream and closes it when aborted', async () => {
    const client = new ReolinkClient(cam);
    const ac = new AbortController();
    const stream = await client.openLive('sub', ac.signal);
    const first: Buffer = await new Promise((resolve) => stream.once('data', resolve));
    expect(first.subarray(0, 3).toString()).toBe('FLV');
    expect(state.activeStreams).toBe(1);
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(state.activeStreams).toBe(0);
  });
});

describe('Semaphore', () => {
  it('never runs more than max tasks at once', async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('releases a slot when a task throws', async () => {
    const gate = new Semaphore(1);
    await expect(gate.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/reolinkClient.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`server/reolink/semaphore.ts`:
```ts
// Caps concurrent camera requests: the camera is small hardware and starts
// dropping connections when many arrive at once.
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
```

`server/reolink/http.ts`:
```ts
import http, { IncomingMessage } from 'node:http';
import https from 'node:https';

export interface CameraTarget {
  protocol: 'https' | 'http';
  host: string; // "ip" or "ip:port"
  tlsServername?: string;
}

export interface OpenOptions {
  method?: 'GET' | 'POST';
  body?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export class TimeoutError extends Error {
  constructor() {
    super('camera did not respond in time');
    this.name = 'TimeoutError';
  }
}

function splitHost(host: string): { hostname: string; port?: number } {
  const i = host.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(host.slice(i + 1))) return { hostname: host.slice(0, i), port: Number(host.slice(i + 1)) };
  return { hostname: host };
}

// Plain node:http(s) rather than fetch: it gives an exact TLS name check
// (servername) for a camera reached by IP, and a raw stream for live video.
// timeoutMs is an inactivity timeout, so it also catches a stalled stream.
export function openRequest(target: CameraTarget, path: string, opts: OpenOptions): Promise<IncomingMessage> {
  const { hostname, port } = splitHost(target.host);
  const tls =
    target.protocol === 'https'
      ? { servername: target.tlsServername, rejectUnauthorized: Boolean(target.tlsServername) }
      : {};
  const lib = target.protocol === 'https' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname,
        port,
        path,
        method: opts.method ?? 'GET',
        signal: opts.signal,
        headers: opts.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(opts.body) } : {},
        ...tls,
      },
      (res) => {
        res.setTimeout(opts.timeoutMs, () => res.destroy(new TimeoutError()));
        resolve(res);
      },
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new TimeoutError()));
    req.on('error', reject);
    req.end(opts.body);
  });
}

export async function readBody(res: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      res.destroy();
      throw new Error('camera response too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
```

`server/reolink/client.ts`:
```ts
import { randomBytes } from 'crypto';
import { IncomingMessage } from 'node:http';
import type { CameraConfig } from '../cameraRegistry';
import { logger } from '../logger';
import { CameraTarget, openRequest, readBody } from './http';
import { Semaphore } from './semaphore';

export type CameraErrorCode = 'camera_offline' | 'camera_auth_failed' | 'camera_error';

// Messages are for logs only and never contain URLs, tokens or passwords;
// clients see just the code.
export class CameraError extends Error {
  constructor(
    readonly code: CameraErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export interface CameraStatus {
  model: string;
  firmware: string;
}

interface ReolinkReply {
  code: number;
  value?: Record<string, unknown>;
  error?: { rspCode?: number; detail?: string };
}

const AUTH_RSP_CODES = new Set([-6]); // "please login first": token unknown or expired
const TOKEN_RENEW_MARGIN_MS = 60_000;
const LOGIN_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

function offline(err: unknown): CameraError {
  const name = err instanceof Error ? err.name : 'Error';
  const code = (err as { code?: string }).code;
  return new CameraError('camera_offline', `camera unreachable (${code ?? name})`);
}

export class ReolinkClient {
  private token: { value: string; expiresAt: number } | null = null;
  private loginInFlight: Promise<string> | null = null;
  private lastLoginFailure = Number.NEGATIVE_INFINITY;
  private readonly gate: Semaphore;
  private readonly timeoutMs: number;
  private readonly target: CameraTarget;

  constructor(
    private readonly cam: CameraConfig,
    private readonly opts: { timeoutMs?: number; maxConcurrent?: number; now?: () => number } = {},
  ) {
    this.gate = new Semaphore(opts.maxConcurrent ?? 2);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.target = { protocol: cam.protocol, host: cam.host, tlsServername: cam.tlsServername };
    if (cam.protocol === 'https' && !cam.tlsServername) {
      logger.warn({ cameraId: cam.id }, 'camera TLS certificate is not verified (no tlsServername configured)');
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async post(cmd: string, param: object, token?: string): Promise<ReolinkReply> {
    const path = `/cgi-bin/api.cgi?cmd=${encodeURIComponent(cmd)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const body = JSON.stringify([{ cmd, action: 0, param }]);
    return this.gate.run(async () => {
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, path, { method: 'POST', body, timeoutMs: this.timeoutMs });
      } catch (err) {
        throw offline(err);
      }
      if (res.statusCode === 503) {
        res.resume();
        throw new CameraError('camera_offline', `${cmd}: camera unavailable (HTTP 503)`);
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new CameraError('camera_error', `${cmd}: HTTP ${res.statusCode}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readBody(res)).toString('utf8'));
      } catch (err) {
        if (err instanceof SyntaxError) throw new CameraError('camera_error', `${cmd}: response is not JSON`);
        throw offline(err);
      }
      const first = Array.isArray(parsed) ? (parsed[0] as ReolinkReply | undefined) : undefined;
      if (!first || typeof first.code !== 'number') throw new CameraError('camera_error', `${cmd}: unexpected response`);
      return first;
    });
  }

  private async login(): Promise<string> {
    const reply = await this.post('Login', {
      User: { Version: '0', userName: this.cam.user, password: this.cam.password },
    });
    const token = (reply.value?.Token ?? {}) as { name?: string; leaseTime?: number };
    if (reply.code !== 0 || !token.name) {
      this.lastLoginFailure = this.now();
      throw new CameraError('camera_auth_failed', `login rejected (rspCode ${reply.error?.rspCode ?? 'unknown'})`);
    }
    this.token = { value: token.name, expiresAt: this.now() + (token.leaseTime ?? 3600) * 1000 };
    return token.name;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_RENEW_MARGIN_MS > this.now()) return this.token.value;
    if (this.loginInFlight) return this.loginInFlight;
    if (this.now() - this.lastLoginFailure < LOGIN_BACKOFF_MS) {
      throw new CameraError('camera_auth_failed', 'login recently rejected; backing off');
    }
    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  async command<T>(cmd: string, param: object = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.post(cmd, param, await this.getToken());
      if (reply.code === 0) return reply.value as T;
      if (attempt === 0 && AUTH_RSP_CODES.has(reply.error?.rspCode ?? 0)) {
        this.token = null;
        continue;
      }
      throw new CameraError('camera_error', `${cmd} failed (rspCode ${reply.error?.rspCode ?? 'unknown'})`);
    }
    throw new CameraError('camera_auth_failed', `${cmd}: session rejected after re-login`);
  }

  async status(): Promise<CameraStatus> {
    const value = await this.command<{ DevInfo?: { model?: string; firmVer?: string } }>('GetDevInfo');
    return { model: value.DevInfo?.model ?? 'unknown', firmware: value.DevInfo?.firmVer ?? 'unknown' };
  }

  // GET endpoints (Snap, FLV) answer an invalid token with JSON or a closed
  // connection instead of rspCode; one retry with a fresh login covers both.
  private async getWithToken(buildPath: (token: string) => string, accept: RegExp, signal?: AbortSignal): Promise<IncomingMessage> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, buildPath(encodeURIComponent(token)), { timeoutMs: this.timeoutMs, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt === 0) {
          this.token = null;
          continue;
        }
        throw offline(err);
      }
      if (res.statusCode === 200 && accept.test(String(res.headers['content-type'] ?? ''))) return res;
      res.resume();
      if (res.statusCode === 503) throw new CameraError('camera_offline', 'camera unavailable (HTTP 503)');
      if (attempt === 0) {
        this.token = null;
        continue;
      }
      throw new CameraError('camera_error', `unexpected response (HTTP ${res.statusCode})`);
    }
    throw new CameraError('camera_error', 'unexpected response');
  }

  async snapshot(): Promise<Buffer> {
    const res = await this.getWithToken(
      (t) => `/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=${randomBytes(6).toString('hex')}&token=${t}`,
      /^image\/jpeg/,
    );
    try {
      return await readBody(res, 8 * 1024 * 1024);
    } catch (err) {
      throw offline(err);
    }
  }

  async openLive(quality: 'sub' | 'main', signal: AbortSignal): Promise<IncomingMessage> {
    return this.getWithToken(
      (t) => `/flv?port=1935&app=bcs&stream=channel0_${quality}.bcs&token=${t}`,
      /^video\/x-flv/,
      signal,
    );
  }
}
```

`server/reolink/clients.ts`:
```ts
import { getCamera } from '../cameraRegistry';
import { ReolinkClient } from './client';

// One client per camera for the life of the process, so the token cache and
// the concurrency gate are shared by every request for that camera.
const clients = new Map<string, ReolinkClient>();

export function getClient(id: string): ReolinkClient | undefined {
  const existing = clients.get(id);
  if (existing) return existing;
  const cam = getCamera(id);
  if (!cam) return undefined;
  const client = new ReolinkClient(cam);
  clients.set(id, client);
  return client;
}

export function resetClients(): void {
  clients.clear();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/reolinkClient.test.ts`, then `npx vitest run`
Expected: all pass, pristine output. The offline test takes up to its 1 s timeout; with nothing listening on port 9 it typically fails immediately with ECONNREFUSED.

- [ ] **Step 5: Commit**

```bash
git add server/reolink test/reolinkClient.test.ts
git commit -m "feat: Reolink camera client with token cache, re-login, backoff and concurrency cap"
```

---

### Task 4: Camera API routes: status, snapshot, live

**Files:**
- Create: `server/routes/cameras.ts`
- Modify: `server/routes/api.ts`, `test/setup.ts`
- Test: `test/cameraRoutes.test.ts`

**Interfaces:**
- Consumes: `getClient`, `resetClients`, `CameraError` (Task 3); `getCamera` (Task 1); `logger`.
- Produces:
  - `GET /api/cameras/:id/status` → `200 {id, online: true, model, firmware}`, or `200 {id, online: false, error: CameraErrorCode}`, or `404 {error:'unknown_camera'}`.
  - `GET /api/cameras/:id/snapshot.jpg` → `image/jpeg`, or the camera error JSON.
  - `GET /api/cameras/:id/live?quality=sub|main` → `video/x-flv` stream, or `503 {error:'too_many_streams'}`, or the camera error JSON.
  - `MAX_LIVE_PER_CAMERA = 4` and `liveStreamCount(id): number` (tests).

- [ ] **Step 1: Write the failing test `test/cameraRoutes.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { liveStreamCount, MAX_LIVE_PER_CAMERA } from '../server/routes/cameras';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createMockCamera, MockState } from './mock-camera/server';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
let camServer: Server;
let camState: MockState;
let appServer: Server;
let base: string;

beforeEach(async () => {
  const mock = createMockCamera({ user: 'u', password: 'p' });
  camState = mock.state;
  camServer = mock.app.listen(0);
  await new Promise((r) => camServer.once('listening', r));
  const port = (camServer.address() as AddressInfo).port;
  setCameras([
    { id: 'cam1', name: 'Den', host: `127.0.0.1:${port}`, protocol: 'http', user: 'u', password: 'p' },
    { id: 'down', name: 'Garage', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetClients();
  appServer = createApp().listen(0);
  await new Promise((r) => appServer.once('listening', r));
  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => camServer.close(() => r()));
  setCameras([]);
  resetClients();
});

// Opens a live stream through the app and resolves with the response once
// the first bytes arrive; the caller destroys it.
function openLive(quality = 'sub'): Promise<http.IncomingMessage & { first: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}/api/cameras/cam1/live?quality=${quality}`, { headers: { Cookie: auth } }, (res) => {
        if (res.statusCode !== 200) {
          resolve(Object.assign(res, { first: Buffer.alloc(0) }));
          return;
        }
        res.once('data', (chunk: Buffer) => resolve(Object.assign(res, { first: chunk })));
      })
      .on('error', reject);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('camera routes', () => {
  it('reports status for an online camera', async () => {
    const res = await request(appServer).get('/api/cameras/cam1/status').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'cam1', online: true, model: 'RLC-1224A', firmware: 'v3.2.0.6011_mock' });
  });

  it('reports an unreachable camera as offline with only an error code', async () => {
    const res = await request(appServer).get('/api/cameras/down/status').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'down', online: false, error: 'camera_offline' });
  });

  it('404s an unknown camera', async () => {
    const res = await request(appServer).get('/api/cameras/nope/status').set('Cookie', auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_camera' });
  });

  it('requires a session', async () => {
    expect((await request(appServer).get('/api/cameras/cam1/status')).status).toBe(401);
    expect((await request(appServer).get('/api/cameras/cam1/live')).status).toBe(401);
  });

  it('proxies a JPEG snapshot, uncached', async () => {
    const res = await request(appServer).get('/api/cameras/cam1/snapshot.jpg').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // Review focus 5: errors carry only a code.
  it('answers a snapshot from an unreachable camera with 503 and no details', async () => {
    const res = await request(appServer).get('/api/cameras/down/snapshot.jpg').set('Cookie', auth);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'camera_offline' });
  });

  it('streams FLV from the camera', async () => {
    const res = await openLive();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/x-flv');
    expect(res.first.subarray(0, 3).toString()).toBe('FLV');
    res.destroy();
  });

  // Review focus 2: a closed tab releases the slot and the camera connection.
  it('releases the stream slot and closes the camera stream when the client disconnects', async () => {
    const res = await openLive();
    expect(liveStreamCount('cam1')).toBe(1);
    expect(camState.activeStreams).toBe(1);
    res.destroy();
    await settle();
    expect(liveStreamCount('cam1')).toBe(0);
    expect(camState.activeStreams).toBe(0);
  });

  it(`refuses more than ${MAX_LIVE_PER_CAMERA} concurrent streams per camera`, async () => {
    const open = await Promise.all(Array.from({ length: MAX_LIVE_PER_CAMERA }, () => openLive()));
    const extra = await request(appServer).get('/api/cameras/cam1/live').set('Cookie', auth);
    expect(extra.status).toBe(503);
    expect(extra.body).toEqual({ error: 'too_many_streams' });
    open.forEach((r) => r.destroy());
    await settle();
    expect(liveStreamCount('cam1')).toBe(0);
  });

  it('treats an unknown quality as sub', async () => {
    const res = await openLive('bogus');
    expect(res.statusCode).toBe(200);
    res.destroy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cameraRoutes.test.ts`
Expected: FAIL, `Cannot find module '../server/routes/cameras'`.

- [ ] **Step 3: Implement**

`server/routes/cameras.ts`:
```ts
import { Router, Request, Response, NextFunction } from 'express';
import { pipeline } from 'stream/promises';
import { getCamera } from '../cameraRegistry';
import { getClient } from '../reolink/clients';
import { CameraError } from '../reolink/client';
import { logger } from '../logger';

export const MAX_LIVE_PER_CAMERA = 4;
const liveCounts = new Map<string, number>();

export function liveStreamCount(id: string): number {
  return liveCounts.get(id) ?? 0;
}

export const camerasRouter = Router();

function cameraId(req: Request, res: Response): string | undefined {
  const id = String(req.params.id);
  if (!getCamera(id)) {
    res.status(404).json({ error: 'unknown_camera' });
    return undefined;
  }
  return id;
}

function sendCameraError(err: unknown, cameraIdValue: string, res: Response, next: NextFunction): void {
  if (!(err instanceof CameraError)) {
    next(err);
    return;
  }
  logger.warn({ cameraId: cameraIdValue, code: err.code, message: err.message }, 'camera_request_failed');
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(err.code === 'camera_error' ? 502 : 503).json({ error: err.code });
}

camerasRouter.get('/api/cameras/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  const id = cameraId(req, res);
  if (!id) return;
  try {
    const status = await getClient(id)!.status();
    res.json({ id, online: true, ...status });
  } catch (err) {
    if (!(err instanceof CameraError)) return next(err);
    logger.warn({ cameraId: id, code: err.code, message: err.message }, 'camera_status_failed');
    res.json({ id, online: false, error: err.code });
  }
});

camerasRouter.get('/api/cameras/:id/snapshot.jpg', async (req: Request, res: Response, next: NextFunction) => {
  const id = cameraId(req, res);
  if (!id) return;
  try {
    const jpeg = await getClient(id)!.snapshot();
    res.type('image/jpeg').send(jpeg);
  } catch (err) {
    sendCameraError(err, id, res, next);
  }
});

camerasRouter.get('/api/cameras/:id/live', async (req: Request, res: Response, next: NextFunction) => {
  const id = cameraId(req, res);
  if (!id) return;
  if (liveStreamCount(id) >= MAX_LIVE_PER_CAMERA) {
    res.status(503).json({ error: 'too_many_streams' });
    return;
  }
  const quality = req.query.quality === 'main' ? 'main' : 'sub';
  liveCounts.set(id, liveStreamCount(id) + 1);
  const abort = new AbortController();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    abort.abort();
    liveCounts.set(id, Math.max(0, liveStreamCount(id) - 1));
  };
  res.on('close', release);
  try {
    const upstream = await getClient(id)!.openLive(quality, abort.signal);
    if (abort.signal.aborted) {
      upstream.destroy();
      return;
    }
    res.status(200).set({ 'Content-Type': 'video/x-flv', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await pipeline(upstream, res);
  } catch (err) {
    // The viewer closing the tab ends the pipeline with a premature-close
    // error; that is the normal way a live stream stops.
    if (abort.signal.aborted) return;
    sendCameraError(err, id, res, next);
  } finally {
    release();
  }
});
```

In `server/routes/api.ts`, import and register the router before the final 404 handler:
```ts
import { camerasRouter } from './cameras';
```
```ts
apiRouter.get('/api/cameras', (_req: Request, res: Response) => {
  res.json(listCameras());
});

apiRouter.use(camerasRouter);

// Last on /api: an unknown API path is JSON, never the SPA's HTML.
```

Append to `test/setup.ts`:
```ts
import { resetClients } from '../server/reolink/clients';

beforeEach(() => resetClients());
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cameraRoutes.test.ts`, then `npx vitest run`
Expected: all pass, pristine output. Camera warnings go through pino at LOG_LEVEL=silent.

- [ ] **Step 5: Commit**

```bash
git add server/routes/cameras.ts server/routes/api.ts test/cameraRoutes.test.ts test/setup.ts
git commit -m "feat: camera status, snapshot and live FLV proxy routes"
```

---

### Task 5: LiveSession: the player lifecycle (swap, retry, teardown)

**Files:**
- Create: `web/src/lib/live.ts`, `web/src/lib/liveSession.ts`
- Test: `web/src/lib/live.test.ts`, `web/src/lib/liveSession.test.ts`

**Interfaces:**
- Produces:
  - `SWAP_AFTER_MS = 540_000` and `STANDBY_RETRY_MS = 5_000`.
  - `retryDelayMs(attempt: number): number`.
  - `supportsHevc(isTypeSupported: (t: string) => boolean): boolean`.
  - `Quality = 'sub' | 'main'`.
  - `liveUrl(cameraId: string, quality: Quality): string`, `snapshotUrl(cameraId: string): string` and `QUALITY_KEY = 'cams-live-quality'`.
  - `PlayerState = 'connecting' | 'playing' | 'reconnecting'`.
  - `interface Player { attach(v: HTMLVideoElement): void; load(): void; play(): void; destroy(): void; onFailure(cb: () => void): void }`.
  - `type PlayerFactory = (url: string) => Player`.
  - `class LiveSession`:
    - `constructor(videos: [HTMLVideoElement, HTMLVideoElement], url: string, factory: PlayerFactory, onState: (s: PlayerState) => void, onActive: (index: 0 | 1) => void)`
    - `start(): void` and `stop(): void`

- [ ] **Step 1: Write the failing tests**

`web/src/lib/live.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { liveUrl, retryDelayMs, snapshotUrl, supportsHevc, SWAP_AFTER_MS } from './live';

describe('live helpers', () => {
  it('swaps well inside the 600 s cluster limit', () => {
    expect(SWAP_AFTER_MS).toBe(9 * 60 * 1000);
  });

  it('backs off exponentially up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('detects HEVC support from MediaSource', () => {
    expect(supportsHevc((t) => t.includes('hvc1'))).toBe(true);
    expect(supportsHevc(() => false)).toBe(false);
  });

  it('builds URLs, encoding the camera id', () => {
    expect(liveUrl('cam1', 'main')).toBe('/api/cameras/cam1/live?quality=main');
    expect(snapshotUrl('a b')).toBe('/api/cameras/a%20b/snapshot.jpg');
  });
});
```

`web/src/lib/liveSession.test.ts`:
```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSession, type Player, type PlayerState } from './liveSession';
import { SWAP_AFTER_MS } from './live';

class FakePlayer implements Player {
  video: HTMLVideoElement | null = null;
  destroyed = false;
  failure: (() => void) | null = null;
  attach(v: HTMLVideoElement) { this.video = v; }
  load() {}
  play() {}
  destroy() { this.destroyed = true; }
  onFailure(cb: () => void) { this.failure = cb; }
  // Test helpers
  startPlaying() { this.video!.dispatchEvent(new Event('playing')); }
  fail() { this.failure!(); }
}

let players: FakePlayer[];
let states: PlayerState[];
let active: number[];
let videos: [HTMLVideoElement, HTMLVideoElement];

function session() {
  return new LiveSession(
    videos,
    '/api/cameras/cam1/live?quality=sub',
    () => {
      const p = new FakePlayer();
      players.push(p);
      return p;
    },
    (s) => states.push(s),
    (i) => active.push(i),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  players = [];
  states = [];
  active = [];
  videos = [document.createElement('video'), document.createElement('video')];
});
afterEach(() => vi.useRealTimers());

describe('LiveSession', () => {
  it('connects on the first video and reports playing', () => {
    const s = session();
    s.start();
    expect(states).toEqual(['connecting']);
    expect(players[0].video).toBe(videos[0]);
    players[0].startPlaying();
    expect(states.at(-1)).toBe('playing');
    expect(active).toEqual([0]);
    s.stop();
  });

  it('swaps to a fresh connection on the other video after 9 minutes, then drops the old one', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    vi.advanceTimersByTime(SWAP_AFTER_MS);
    expect(players).toHaveLength(2);
    expect(players[1].video).toBe(videos[1]);
    expect(players[0].destroyed).toBe(false); // old keeps playing until the new one does
    players[1].startPlaying();
    expect(active.at(-1)).toBe(1);
    expect(players[0].destroyed).toBe(true);
    expect(states.filter((x) => x === 'reconnecting')).toHaveLength(0);
    s.stop();
  });

  // Review focus 1: a failing active stream reconnects with backoff and recovers.
  it('reconnects the active stream with backoff and recovers', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    players[0].fail();
    expect(states.at(-1)).toBe('reconnecting');
    expect(players[0].destroyed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(players).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(players).toHaveLength(2);
    players[1].fail();
    vi.advanceTimersByTime(1999);
    expect(players).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(players).toHaveLength(3);
    players[2].startPlaying();
    expect(states.at(-1)).toBe('playing');
    s.stop();
  });

  it('keeps the active stream when the standby fails, and retries the swap', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    vi.advanceTimersByTime(SWAP_AFTER_MS);
    players[1].fail();
    expect(players[1].destroyed).toBe(true);
    expect(players[0].destroyed).toBe(false);
    expect(states.at(-1)).toBe('playing');
    vi.advanceTimersByTime(5000);
    expect(players).toHaveLength(3);
    s.stop();
  });

  // Review focus 4: teardown leaves nothing running.
  it('stop() destroys every player and cancels timers', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    s.stop();
    expect(players.every((p) => p.destroyed)).toBe(true);
    vi.advanceTimersByTime(SWAP_AFTER_MS * 2);
    expect(players).toHaveLength(1);
  });

  it('ignores failures from players it already replaced', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    vi.advanceTimersByTime(SWAP_AFTER_MS);
    players[1].startPlaying();
    players[0].fail(); // late error from the destroyed player
    expect(states.at(-1)).toBe('playing');
    expect(players).toHaveLength(2);
    s.stop();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run web/src/lib/live.test.ts web/src/lib/liveSession.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`web/src/lib/live.ts`:
```ts
export type Quality = 'sub' | 'main';

// Knative cuts a response at 600 s; the player moves to a fresh connection
// well before that so the cut is never visible.
export const SWAP_AFTER_MS = 9 * 60 * 1000;
export const STANDBY_RETRY_MS = 5_000;
export const QUALITY_KEY = 'cams-live-quality';

export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

// The main stream is H.265; only offer it where the browser can decode it.
export function supportsHevc(isTypeSupported: (type: string) => boolean): boolean {
  return isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"');
}

export function liveUrl(cameraId: string, quality: Quality): string {
  return `/api/cameras/${encodeURIComponent(cameraId)}/live?quality=${quality}`;
}

export function snapshotUrl(cameraId: string): string {
  return `/api/cameras/${encodeURIComponent(cameraId)}/snapshot.jpg`;
}
```

`web/src/lib/liveSession.ts`:
```ts
import { retryDelayMs, STANDBY_RETRY_MS, SWAP_AFTER_MS } from './live';

export type PlayerState = 'connecting' | 'playing' | 'reconnecting';

export interface Player {
  attach(video: HTMLVideoElement): void;
  load(): void;
  play(): void;
  destroy(): void;
  onFailure(cb: () => void): void;
}

export type PlayerFactory = (url: string) => Player;

interface Slot {
  player: Player;
  onPlaying: () => void;
}

// Owns the two <video> elements of one live view. One is "active" (visible);
// every SWAP_AFTER_MS a fresh connection starts on the other one and takes
// over once it is actually playing, so the server-side response limit never
// shows. A failure of the active stream reconnects with backoff; a failure
// of the standby just retries the swap later. Framework-free for testing.
export class LiveSession {
  private slots: [Slot | null, Slot | null] = [null, null];
  private active: 0 | 1 = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly videos: [HTMLVideoElement, HTMLVideoElement],
    private readonly url: string,
    private readonly factory: PlayerFactory,
    private readonly onState: (s: 'connecting' | 'playing' | 'reconnecting') => void,
    private readonly onActive: (index: 0 | 1) => void,
  ) {}

  start(): void {
    this.onState('connecting');
    this.launch(0);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.slots.forEach((_, i) => this.drop(i as 0 | 1));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) fn();
    }, ms);
  }

  private drop(i: 0 | 1): void {
    const slot = this.slots[i];
    if (!slot) return;
    this.slots[i] = null;
    this.videos[i].removeEventListener('playing', slot.onPlaying);
    slot.player.destroy();
  }

  private launch(i: 0 | 1): void {
    this.drop(i);
    const player = this.factory(this.url);
    const slot: Slot = { player, onPlaying: () => this.playing(i, slot) };
    this.slots[i] = slot;
    this.videos[i].addEventListener('playing', slot.onPlaying);
    player.onFailure(() => this.failed(i, slot));
    player.attach(this.videos[i]);
    player.load();
    player.play();
  }

  private playing(i: 0 | 1, slot: Slot): void {
    if (this.stopped || this.slots[i] !== slot) return;
    this.videos[i].removeEventListener('playing', slot.onPlaying);
    const other = (1 - i) as 0 | 1;
    this.active = i;
    this.attempt = 0;
    this.onActive(i);
    this.drop(other);
    this.onState('playing');
    this.schedule(SWAP_AFTER_MS, () => this.launch(other));
  }

  private failed(i: 0 | 1, slot: Slot): void {
    if (this.stopped || this.slots[i] !== slot) return; // stale player
    this.drop(i);
    const activeAlive = i !== this.active && this.slots[this.active] !== null;
    if (activeAlive) {
      this.schedule(STANDBY_RETRY_MS, () => this.launch(i));
      return;
    }
    this.onState('reconnecting');
    const delay = retryDelayMs(this.attempt++);
    this.schedule(delay, () => this.launch(i));
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/lib`, then `npm run check`
Expected: all pass; `check` is clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/live.ts web/src/lib/liveSession.ts web/src/lib/live.test.ts web/src/lib/liveSession.test.ts
git commit -m "feat: LiveSession with 9-minute seamless swap, backoff reconnect and teardown"
```

---

### Task 6: Live page UI

**Files:**
- Modify: `package.json` (via `npm install -D mpegts.js`)
- Create: `web/src/lib/mpegtsPlayer.ts`, `web/src/components/LivePlayer.svelte`
- Modify: `web/src/pages/Live.svelte`, `web/src/lib/icons.ts`

**Interfaces:**
- Consumes:
  - `LiveSession`, `PlayerState`, `Player`, `liveUrl`, `snapshotUrl`, `supportsHevc`, `QUALITY_KEY`, `Quality` (Task 5)
  - `getJson` and the stores `cameras` and `selectedCameraId` (Plan 1)
  - `/api/cameras/:id/status` (Task 4)
- Produces (e2e test ids):
  - `live-video` (the visible video element)
  - `live-badge`
  - `live-state` (text: Connecting… / Live / Reconnecting…)
  - `offline-banner` and `retry`
  - `quality-toggle` (present only when HEVC is supported), `mute-toggle`
  - `snapshot` (a link) and `fullscreen`

- [ ] **Step 1: Install mpegts.js**

Run: `npm install -D mpegts.js@^1.8`
Expected: `package.json` devDependencies include `mpegts.js`. It is bundled by Vite and never installed in the runtime image.

- [ ] **Step 2: `web/src/lib/mpegtsPlayer.ts`**

```ts
import mpegts from 'mpegts.js';
import type { Player } from './liveSession';

// Adapts mpegts.js to the Player interface LiveSession drives. A finished
// load (the server or camera ended the stream) counts as a failure, so the
// session reconnects instead of freezing on the last frame.
export function mpegtsPlayer(url: string): Player {
  const p = mpegts.createPlayer(
    { type: 'flv', isLive: true, url, hasAudio: true, hasVideo: true },
    {
      enableStashBuffer: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.3,
      lazyLoad: false,
    },
  );
  let failed = false;
  return {
    attach: (video) => p.attachMediaElement(video),
    load: () => p.load(),
    play: () => {
      void Promise.resolve(p.play()).catch(() => {});
    },
    destroy: () => {
      try {
        p.pause();
        p.unload();
        p.detachMediaElement();
      } finally {
        p.destroy();
      }
    },
    onFailure: (cb) => {
      const once = () => {
        if (failed) return;
        failed = true;
        cb();
      };
      p.on(mpegts.Events.ERROR, once);
      p.on(mpegts.Events.LOADING_COMPLETE, once);
    },
  };
}
```

- [ ] **Step 3: Icons**

In `web/src/lib/icons.ts`, add these entries to `ICONS`:
```ts
  camera: 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zm8 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  volumeOff: 'M11 5 6 9H3v6h3l5 4V5zm11 4-6 6m0-6 6 6',
  volumeOn: 'M11 5 6 9H3v6h3l5 4V5zm4.5 3.5a5 5 0 0 1 0 7m2.8-9.8a9 9 0 0 1 0 12.6',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
```

- [ ] **Step 4: `web/src/components/LivePlayer.svelte`**

```svelte
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { LiveSession, type PlayerState } from '../lib/liveSession';
  import { liveUrl, type Quality } from '../lib/live';
  import { mpegtsPlayer } from '../lib/mpegtsPlayer';

  let {
    cameraId,
    quality,
    muted,
    onstate,
  }: { cameraId: string; quality: Quality; muted: boolean; onstate: (s: PlayerState) => void } = $props();

  let videoA: HTMLVideoElement | undefined = $state();
  let videoB: HTMLVideoElement | undefined = $state();
  let active: 0 | 1 = $state(0);
  let session: LiveSession | null = null;

  // Review focus 4: a change of camera or quality tears the old session down
  // before the new one starts.
  $effect(() => {
    const url = liveUrl(cameraId, quality);
    if (!videoA || !videoB) return;
    // untrack: a parent re-creating its callback must not restart the stream.
    const report = untrack(() => onstate);
    session?.stop();
    active = 0;
    session = new LiveSession([videoA, videoB], url, mpegtsPlayer, (s) => report(s), (i) => (active = i));
    session.start();
    return () => {
      session?.stop();
      session = null;
    };
  });

  onDestroy(() => session?.stop());
</script>

<div class="stage">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={videoA} class:on={active === 0} data-testid={active === 0 ? 'live-video' : undefined} {muted} playsinline autoplay></video>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={videoB} class:on={active === 1} data-testid={active === 1 ? 'live-video' : undefined} {muted} playsinline autoplay></video>
</div>

<style>
  .stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 0.2s ease; }
  video.on { opacity: 1; }
</style>
```

- [ ] **Step 5: Replace `web/src/pages/Live.svelte`**

```svelte
<script lang="ts">
  import LivePlayer from '../components/LivePlayer.svelte';
  import Icon from '../components/Icon.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { getJson } from '../lib/api';
  import { QUALITY_KEY, snapshotUrl, supportsHevc, type Quality } from '../lib/live';
  import type { PlayerState } from '../lib/liveSession';

  interface CameraStatus {
    id: string;
    online: boolean;
    model?: string;
    firmware?: string;
    error?: string;
  }

  const hevc = typeof MediaSource !== 'undefined' && supportsHevc((t) => MediaSource.isTypeSupported(t));

  function initialQuality(): Quality {
    try {
      return hevc && localStorage.getItem(QUALITY_KEY) === 'main' ? 'main' : 'sub';
    } catch {
      return 'sub';
    }
  }

  let quality: Quality = $state(initialQuality());
  let muted = $state(true);
  let playerState: PlayerState = $state('connecting');
  let status: CameraStatus | null = $state(null);
  let checking = $state(false);
  let container: HTMLDivElement | undefined = $state();

  const camera = $derived($cameras.find((c) => c.id === $selectedCameraId) ?? null);

  async function checkStatus(id: string) {
    checking = true;
    try {
      status = await getJson<CameraStatus>(`/api/cameras/${encodeURIComponent(id)}/status`);
    } catch {
      status = { id, online: false, error: 'camera_error' };
    } finally {
      checking = false;
    }
  }

  $effect(() => {
    const id = $selectedCameraId;
    status = null;
    if (id) void checkStatus(id);
  });

  function toggleQuality() {
    quality = quality === 'sub' ? 'main' : 'sub';
    try {
      localStorage.setItem(QUALITY_KEY, quality);
    } catch {
      // not persisted
    }
  }

  function fullscreen() {
    void container?.requestFullscreen?.().catch(() => {});
  }

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
</script>

<section class="page">
  <header class="head">
    <h1 data-testid="page-title">Live</h1>
    {#if camera}<span class="cam">{camera.name}</span>{/if}
    {#if status?.online}
      <span class="badge" data-testid="live-badge" class:ok={playerState === 'playing'}>● {playerState === 'playing' ? 'LIVE' : '…'}</span>
      <span class="state" data-testid="live-state">
        {playerState === 'playing' ? 'Live' : playerState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </span>
    {/if}
  </header>

  {#if !camera}
    <div class="placeholder">No cameras are configured.</div>
  {:else if status && !status.online}
    <div class="offline" data-testid="offline-banner" role="alert">
      <strong>{camera.name} is offline.</strong>
      <span>The camera could not be reached{status.error === 'camera_auth_failed' ? ' (sign-in to the camera failed)' : ''}.</span>
      <button data-testid="retry" disabled={checking} onclick={() => checkStatus(camera.id)}>
        <Icon name="refresh" size={16} /> {checking ? 'Checking…' : 'Retry'}
      </button>
    </div>
  {:else if status?.online}
    <div class="viewer" bind:this={container}>
      <LivePlayer cameraId={camera.id} {quality} {muted} onstate={(s) => (playerState = s)} />
      <div class="controls">
        <button data-testid="mute-toggle" aria-pressed={!muted} onclick={() => (muted = !muted)} title={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'volumeOff' : 'volumeOn'} size={18} /><span>{muted ? 'Muted' : 'Sound'}</span>
        </button>
        {#if hevc}
          <button data-testid="quality-toggle" aria-pressed={quality === 'main'} onclick={toggleQuality} title="Switch stream quality">
            {quality === 'main' ? 'HD' : 'SD'}
          </button>
        {/if}
        <a data-testid="snapshot" href={snapshotUrl(camera.id)} download={`${camera.id}-${stamp()}.jpg`} title="Save a snapshot">
          <Icon name="camera" size={18} /><span>Snapshot</span>
        </a>
        <button data-testid="fullscreen" onclick={fullscreen} title="Fullscreen"><Icon name="expand" size={18} /></button>
      </div>
      <p class="meta">{status.model} · firmware {status.firmware}</p>
    </div>
  {:else}
    <div class="placeholder">Checking camera…</div>
  {/if}
</section>

<style>
  .head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .head h1 { margin: 0; }
  .cam { color: var(--muted); font-size: 15px; }
  .badge { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; padding: 3px 9px; border-radius: 999px; background: var(--surface-2); color: var(--muted); }
  .badge.ok { background: var(--danger); color: var(--on-grad); }
  .state { font-size: 13px; color: var(--muted); }
  .viewer { display: flex; flex-direction: column; gap: 10px; max-width: 1280px; }
  .viewer:fullscreen { max-width: none; background: #000; justify-content: center; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; }
  .controls button, .controls a {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 13px;
    text-decoration: none; cursor: pointer; transition: background-color 0.15s ease;
  }
  .controls button:hover, .controls a:hover { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .controls button[aria-pressed='true'] { border-color: var(--accent); }
  .meta { margin: 0; font-size: 12px; color: var(--muted); }
  .offline {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 16px 18px; border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }
  .offline button {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--surface-2); cursor: pointer;
  }
</style>
```

- [ ] **Step 6: Build and type-check**

Run: `npm run build && npm run check && npx vitest run`
Expected: build clean with no Svelte warnings, `check` clean, all tests pass. If the Svelte compiler warns, fix it the way the message suggests, keeping behaviour and test ids, and note the change in the report.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json web
git commit -m "feat: Live page with mpegts.js player, HD toggle, mute, snapshot, fullscreen and offline state"
```

---

### Task 7: E2E with the mock camera, in Chrome

**Files:**
- Modify: `playwright.config.ts`, `e2e/cameras.json`, `e2e/shell.spec.ts`
- Create: `e2e/live.spec.ts`

**Interfaces:**
- Consumes: the test ids from Task 6, the mock camera CLI from Task 2, `signIn` (Plan 1).

- [ ] **Step 1: Point e2e at the mock camera and an unreachable one**

`e2e/cameras.json`:
```json
[
  { "id": "cam1", "name": "Den", "host": "127.0.0.1:8098", "protocol": "http", "user": "e2e", "password": "e2e-not-a-real-password" },
  { "id": "garage", "name": "Garage", "host": "127.0.0.1:9", "protocol": "http", "user": "e2e", "password": "e2e-not-a-real-password" }
]
```

In `playwright.config.ts`:
- Set `channel: 'chrome'` in both projects. Playwright's bundled Chromium can't decode H.264; GitHub's Ubuntu runners have Chrome preinstalled.
- Replace `webServer` with an array that also starts the mock camera:
```ts
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  // Requires `npm run build` first. The mock camera stands in for the Reolink
  // (e2e/cameras.json points "Den" at it); "Garage" is deliberately unreachable.
  webServer: [
    { command: 'npx tsx test/mock-camera/cli.ts', port: 8098, reuseExistingServer: !process.env.CI },
    { command: 'npm start', port: E2E_PORT, reuseExistingServer: !process.env.CI, env: E2E_ENV },
  ],
```

In `e2e/shell.spec.ts`, change the picker expectation to `toHaveText(['Den', 'Garage'])`.

- [ ] **Step 2: Write `e2e/live.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('live video plays from the camera', async ({ page }) => {
  await page.goto('/app/live');
  await expect(page.getByTestId('live-state')).toHaveText('Live', { timeout: 15_000 });
  const video = page.getByTestId('live-video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 15_000 })
    .toBe(true);
  await expect(page.getByTestId('live-badge')).toContainText('LIVE');
});

test('audio starts muted and can be toggled', async ({ page }) => {
  await page.goto('/app/live');
  const video = page.getByTestId('live-video');
  await expect(video).toHaveJSProperty('muted', true);
  await page.getByTestId('mute-toggle').click();
  await expect(page.getByTestId('live-video')).toHaveJSProperty('muted', false);
});

test('snapshot link downloads a JPEG', async ({ page }) => {
  await page.goto('/app/live');
  const link = page.getByTestId('snapshot');
  await expect(link).toHaveAttribute('href', '/api/cameras/cam1/snapshot.jpg');
  const res = await page.request.get('/api/cameras/cam1/snapshot.jpg');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/jpeg');
});

test('an unreachable camera shows the offline banner with retry', async ({ page }) => {
  await page.goto('/app/live');
  await page.getByTestId('camera-picker').selectOption('garage');
  await expect(page.getByTestId('offline-banner')).toContainText('Garage is offline');
  await page.getByTestId('retry').click();
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(page.getByTestId('live-video')).toHaveCount(0);
});

// Review focus 4: switching cameras tears the stream down.
test('switching away from a live camera stops its video', async ({ page }) => {
  await page.goto('/app/live');
  await expect(page.getByTestId('live-state')).toHaveText('Live', { timeout: 15_000 });
  await page.getByTestId('camera-picker').selectOption('garage');
  await expect(page.locator('video')).toHaveCount(0);
});

test('camera API rejects unknown cameras', async ({ page }) => {
  const res = await page.request.get('/api/cameras/nope/status');
  expect(res.status()).toBe(404);
});
```

- [ ] **Step 3: Run the suite**

Run: `npm run build && npm run test:e2e`
Expected: every spec passes on both projects, and ports 8098 and 8099 are free afterwards. If Chrome isn't installed locally, run `npx playwright install chrome` and say so in the report.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts e2e
git commit -m "test: e2e live video against the mock camera in Chrome"
```

---

### Task 8: CHANGELOG reset after release

**Files:**
- Modify: `.github/workflows/deploy-production.yml`, `CHANGELOG.md`

- [ ] **Step 1: Add a final step to `deploy-production.yml`**, after "Tag the release":
```yaml
      # The release notes harvested [Unreleased]; empty it on main so the next
      # release starts clean. Runs only after a successful release.
      - name: Reset the Unreleased changelog on main
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          VERSION: ${{ steps.ver.outputs.version }}
        run: |
          set -euo pipefail
          rm -rf /tmp/cams-main
          git clone --depth 1 --branch main "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" /tmp/cams-main
          cd /tmp/cams-main
          awk '
            /^## \[Unreleased\]/ { print; print ""; skip = 1; next }
            skip && /^## / { skip = 0 }
            !skip { print }
          ' CHANGELOG.md > CHANGELOG.new
          if cmp -s CHANGELOG.md CHANGELOG.new; then echo "Unreleased already empty"; exit 0; fi
          mv CHANGELOG.new CHANGELOG.md
          git config user.name "cams-deploy-bot"
          git config user.email "actions@users.noreply.github.com"
          git commit -am "chore: clear Unreleased after v${VERSION}"
          git push
          rm -rf /tmp/cams-main
```

- [ ] **Step 2: Put this plan's entry in `CHANGELOG.md`** under `## [Unreleased]`, replacing the existing line (that line was already released in v2026.09.25.2):
```markdown
- Live video from the camera: low-latency player, HD where the browser supports it, mute, snapshot, fullscreen, and an offline state with retry. The stream renews itself every 9 minutes without a visible cut.
```

- [ ] **Step 3: Validate and commit**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-production.yml')); print('yaml ok')"`
```bash
git add .github/workflows/deploy-production.yml CHANGELOG.md
git commit -m "ci: clear Unreleased on main after each release"
```

---

### Task 9 (controller, ops): the `cams` camera user, the registry Secret, and the open checks

The controller runs this directly (Plan 1 Ruling 2 pattern). It needs Klaus to create the Secret.

- [ ] **Step 1: Write `scripts/create-camera-user.sh`**

```bash
#!/usr/bin/env bash
# Creates (or resets) the dedicated `cams` admin user on the camera and writes
# the cams-cameras Secret the app reads. Never prints credentials.
#   usage: scripts/create-camera-user.sh [env-file]   (default ~/Development/reolink/.env)
# Needs REOLINK_IP and REOLINK_PASSWORD (the camera's own admin) in the env file.
set -euo pipefail
ENV_FILE="${1:-$HOME/Development/reolink/.env}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/k3s-config}"
set -a; . "$ENV_FILE"; set +a
: "${REOLINK_IP:?missing}"; : "${REOLINK_PASSWORD:?missing}"
CAMS_CAMERA_PASSWORD=$(python3 -c 'import secrets,string;print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(24)))')
export REOLINK_IP REOLINK_PASSWORD CAMS_CAMERA_PASSWORD
python3 - <<'PY'
import json, os, ssl, urllib.request
ip = os.environ["REOLINK_IP"]; ctx = ssl._create_unverified_context()
def call(cmd, param, token=None):
    url = f"https://{ip}/cgi-bin/api.cgi?cmd={cmd}" + (f"&token={token}" if token else "")
    body = json.dumps([{"cmd": cmd, "action": 0, "param": param}]).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, context=ctx, timeout=20))[0]
def login(user, pw):
    r = call("Login", {"User": {"Version": "0", "userName": user, "password": pw}})
    if r.get("code") != 0: raise SystemExit(f"login as {user} failed: rspCode {r.get('error',{}).get('rspCode')}")
    return r["value"]["Token"]["name"]
admin = login("admin", os.environ["REOLINK_PASSWORD"])
try:
    users = [u["userName"] for u in call("GetUser", {}, admin)["value"]["User"]]
    if "cams" in users:
        r = call("DelUser", {"User": {"userName": "cams"}}, admin)
        print("removed existing cams user:", r.get("code"))
    r = call("AddUser", {"User": {"userName": "cams", "password": os.environ["CAMS_CAMERA_PASSWORD"], "level": "admin"}}, admin)
    if r.get("code") != 0: raise SystemExit(f"AddUser failed: {r.get('error')}")
    print("created cams user (level admin)")
finally:
    call("Logout", {}, admin)
t = login("cams", os.environ["CAMS_CAMERA_PASSWORD"])
info = call("GetDevInfo", {}, t)["value"]["DevInfo"]
print("verified: cams can read", info["model"], info["firmVer"])
call("Logout", {}, t)
PY
python3 - <<'PY' | kubectl -n cams create secret generic cams-cameras --from-file=cameras.json=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
import json, os
print(json.dumps([{"id": "cam1", "name": "Den", "host": os.environ["REOLINK_IP"], "protocol": "https",
                   "tlsServername": "cam1.skylar.technology", "user": "cams", "password": os.environ["CAMS_CAMERA_PASSWORD"]}]))
PY
kubectl -n cams describe secret cams-cameras | sed -n '/^Data/,$p'
```
Check `bash -n`, then commit on the Plan 2 branch.

- [ ] **Step 2: Klaus runs it.** Expected output: "created cams user", "verified: cams can read RLC-1224A …", and a `cameras.json` key in the Secret. If AddUser fails, stop and report the error. §11's open check ("a second admin has the same API rights") is answered by the smoke test in Task 10, which uses snapshot and live through the cams user.

- [ ] **Step 3: Open check: can camera HTTP (port 80) go off again?** Using the admin account:
  1. Set `httpEnable: 0` with `SetNetPort`, keeping every other field.
  2. Confirm over HTTPS that `Snap`, FLV live (first bytes `FLV`) and `Download` of a sub-stream clip still work.
  3. If any of them fails, restore `httpEnable: 1` and record which one needs it.
  4. Record the result in the Obsidian note `Cameras/Reolink RLC-1224A.md` (the ports table).

---

### Task 10 (controller, ops): Ship and verify on the real camera

- [ ] **Step 1: Full local gate.** Run `npm ci && npx vitest run && npm run build && npm run check && npm audit --audit-level=high && npm run test:e2e`. Everything must be green.
- [ ] **Step 2: Ship.** Open a PR from the branch to `main` and merge it once `test`, `e2e` and `codeql` are green. Then open a PR from `main` to `production`, and merge it once the same checks are green. Watch `deploy-production`. The `cams-cameras` Secret must exist before the deploy, because the app reads the registry at startup.
- [ ] **Step 3: Real-camera verification.**
  - `kubectl -n cams logs` should contain no `camera_request_failed` lines after one page view.
  - Klaus opens `/app/live` and sees video within a few seconds, with the LIVE badge.
  - Snapshot downloads a 4512×2512 JPEG. HD appears in Chrome/Safari on macOS and plays.
  - Klaus leaves Live open for 12 minutes or more; the picture continues without a visible cut, which confirms the 600 s swap.
  - After the deploy, the release-reset step leaves `## [Unreleased]` empty on main.
- [ ] **Step 4: Obsidian.** Ask the kube-setup session to note in Services that cams now reads the `cams-cameras` Secret, whose `user` is a dedicated camera user.
