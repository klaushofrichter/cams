# Multi-camera P3 (cams mapping) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cams maps several of its cameras onto one cam-proxy, with one upstream event stream per proxy fanned out to those cameras, one group object shared by the stream and the Archive, one camera-list read per proxy, and a `scripts/cameras-config.ts` generator that writes `cameras.json` from a short list of proxies.

**Architecture:** A *proxy group* is every `cameras.json` entry with the same proxy `url` + `token` (`server/proxy/groups.ts`). The group owns the one `ProxyClient`, the one `ProxyStream` (subscribed with `?cam=<the group's proxy ids>`), and the Archive's `via`/`toCams`; messages are fanned out to the cams cameras mapped from their `cam`. The generator's logic is a library (`server/cameraImport.ts`, the seam spec §13.4 names) that the thin CLI `scripts/cameras-config.ts` calls; its pin path uses `server/tls/` helpers (fingerprints, fetching `/tls/ca.pem` against a pin, an undici dispatcher that trusts only the site CA), which P5 later reuses for the runtime.

**Tech Stack:** Node 26, TypeScript 7 (CommonJS), Express 5, vitest 5, supertest, Playwright, undici 8 (new direct dependency, already in the lockfile transitively), OpenSSL CLI (fixtures only), cam-sim, the released cam-proxy image (e2e Silo).

**Spec:** cam-proxy `docs/superpowers/specs/2026-10-05-multi-camera-host-design.md` (cam-proxy PR #168), §12.1, §12.2, §12.4, §12.5 (not built), §13, §15 ("cams", "livestack"), §16 row P3. The P5 part (TLS in cams) is `docs/superpowers/plans/2026-10-05-multi-camera-p5-cams-tls.md`.

## Global Constraints

- The Pi keeps working unchanged: `deploy/pi/cameras.example.json` (one camera, `"host": "from-proxy"`, `http://127.0.0.1:8480`, `tlsServername: "cam1.skylar.technology"`) loads and behaves exactly as today (spec §11, decision 5).
- The cluster's current `cameras.json` (cam1 → the Pi's proxy `http://192.168.1.220:8480`, cam2 → `http://cam-proxy.cam-proxy.svc.cluster.local:8480`) keeps working without an edit (spec §4.2, §12.1 "keep the file format (a Secret in the cluster) unchanged").
- `cameras.json` stays an array of cameras; several entries may name the same proxy; `proxy.camera` maps cams's id to the proxy's id (spec §12.1).
- Proxy group = entries with the same `url` + `token` (spec §12.1, the archive's rule `archive.ts:27`).
- One upstream SSE stream per proxy group, subscribed with `?cam=<the group's proxy ids>`; unknown cams are dropped (spec §12.2).
- The SSE group and the archive group are the same object, `server/proxy/groups.ts` (spec §12.4).
- cams camera ids are unique across all proxies; proxy-local ids may collide (spec §13.2).
- Generator: `scripts/cameras-config.ts`, run with `npx tsx scripts/cameras-config.ts`; input by default `cameras-config.json` next to the output, mode 600, never committed; secrets may be `{"env": "NAME"}` or `{"file": "…"}`; no secrets on the command line; never prints a secret (diffs show `•••`); dry run by default; `--write` writes atomically, mode 600, keeping `cameras.json.bak-<time>`; `--prune` drops cameras a proxy no longer lists (spec §13.3).
- Generator checks: an id collision across proxies stops it naming both; an unreachable proxy or a wrong pin stops it and nothing is written (spec §13.3).
- Never log camera passwords, tokens, cookies or client IPs (cams CLAUDE.md).
- Keep the fake proxy (`test/proxy/fakeProxy.ts`) in step with cam-proxy's client API (cams CLAUDE.md).
- Never run the real-proxy e2e on a Mac or the home LAN (cams CLAUDE.md); never touch the Pi, the cluster or a real camera.
- Every user-visible change goes under `## [Unreleased]` in CHANGELOG.md; never a version in the sources.

## Review Focus

1. **A proxy restart while serving two cams cameras**: both cameras resume from the one stream's last id, no message lost or doubled for either → test in Task 3 ("resumes both cameras after a drop").
2. **A message for a proxy camera no cams camera maps** (another cams installation's camera on the same host, or a camera added on the proxy before the generator re-ran): dropped, never shown on another camera → test in Task 3 ("drops cameras it doesn't map").
3. **Switching off the last switched-on camera of a group, then one back on**: the upstream closes, then reopens with only that camera → test in Task 3 ("re-subscribes on the switch").
4. **The generator against two proxies where the second is unreachable** after the first answered: nothing written, the old file untouched → test in Task 10 ("writes nothing when a later proxy fails").
5. **A secret in an error or a diff** (a token that changed, a `{"file"}` that is missing): the output shows `•••` or the field's path, never the value → tests in Task 9 ("never shows a secret in the diff") and Task 7 ("names the field, never the value").

---

## Rulings (spec gaps, decided here)

- **Ruling: `adminToken` may be absent on some entries of a group; only two different set values are a startup error** — why: spec §12.1 says it "must be equal", but `e2e/cameras.json` already has `cam1` (with `adminToken`) and `barn` (without) on one fake proxy, and today each camera's sign-in link depends on its own entry; keeping `adminToken` per camera changes nothing visible — cost if wrong: a group with one entry lacking `adminToken` keeps no sign-in link for that camera, as today.
- **Ruling: `cam` is always sent as the sorted, de-duplicated proxy ids joined by `,`, and cams still filters each message by its `cam`** — why: today's cam-proxy (`src/stream/sse.ts:15,116`) compares `?cam=` with one id, so `cam=a,b` to an old single-camera proxy would deliver nothing; a group with two different proxy ids only exists on a multi-camera (new) proxy, and the client-side filter is the safety net — cost if wrong: two cams entries mapped to two ids on an old one-camera proxy get no live events (a config that can't work anyway: the old proxy has one camera).
- **Ruling: two cams cameras mapped to the same proxy id both get its messages** — why: today each had its own stream and got them; the Archive keeps its "first wins" `toCams` — cost if wrong: duplicate notifications for a deliberately duplicated camera.
- **Ruling: the camera list (`GET /api/cameras`) is read once per group at a time (requests within 2 s share one answer)** — why: names, addresses and the Settings proxy info all read it; four cameras coming up together would otherwise ask four times (spec §12.2 "one stream per proxy" in spirit) — cost if wrong: a name changed within those 2 s shows on the next read.
- **Ruling: the generator's input is `{"proxies": [ … ]}`, per-camera settings under `cameras: {"<proxy id>": {…}}`, a camera's TLS name per camera only** — why: spec §13.3 lists the fields but not the shape; a per-proxy camera TLS name can't serve several cameras — cost if wrong: one rename of the input format before anyone uses it (no user yet).
- **Ruling: an existing entry matched by `proxy.url` + `proxy.camera` keeps its id, name, `webUiUrl` and `webUiNote`; an input `id` that differs is reported, not applied** — why: spec §13.3 "keeps its cams id and name, so preferences, the archive's `via` and links don't change" — cost if wrong: a wanted rename is done by hand in the file.
- **Ruling: entries without a proxy, and entries of proxies not in the input, are kept untouched in place** — why: the file also holds direct cameras (e2e Garage/Porch/Shed); the generator manages only the proxies it was given — cost if wrong: none for the listed proxies; `--prune` never touches unlisted proxies.
- **Ruling: the generator refuses an input file readable by group or others** — why: spec §13.3 "mode 600"; it holds tokens and passwords — cost if wrong: one `chmod 600` before the first run.
- **Ruling: the generated file is validated with cams's own registry parser before anything is written** — why: a file cams can't load would stop cams at its next start — cost if wrong: none (a refused write names the entry and field).
- **Ruling: the real-proxy e2e two-camera variant (Task 11) and the livestack multi-camera variant (Task 12) wait for cam-proxy's P1+P2 (`cameras[]`) to be released / on `origin/main`** — why: the released image pinned in `e2e/env.ts` and the livestack's `origin/main` worktree must serve `cameras[]`; the rest of P3 depends only on the fake proxy — cost if wrong: those two tasks start later; the others don't wait.
- **Ruling: P3 builds the site-CA fetch (`server/tls/`) and its HTTPS fake-proxy mode** — why: spec §13.3 "its pin path is tested against a fake proxy with a test CA" in P3; P5 reuses the same modules for the runtime — cost if wrong: none; the modules are small and tested here.
- **Ruling: CA fingerprints are compared as 64 lowercase hex digits; input may be `SHA256:` + hex, with or without colons, any case** — why: the spec shows `"SHA256:…"` but no exact encoding, and Node gives `AB:CD:…` — cost if wrong: a base64 (OpenSSH-style) fingerprint is refused with a clear message.

## File Structure

| File | Responsibility |
|---|---|
| `server/proxy/groupKey.ts` (new) | `proxyGroupKey(p)`: url (trailing slashes stripped) + NUL + token |
| `server/proxy/groups.ts` (new) | `ProxyGroup`, `proxyGroups()`, `groupOf()`, `activeMembers()`, `remoteIds()` |
| `server/cameraRegistry.ts` | `allCameras()`, `parseCameras()` split out of `loadCameras()`, group checks |
| `server/proxy/client.ts` | one `ProxyClient` per group; `proxyClientFor()` (ignores the switch) |
| `server/proxy/archive.ts` | `archiveProxies()` built from the groups; `ArchiveProxy.group` |
| `server/proxy/stream.ts` | `ProxyStream` emits `{remote, type, data}`, `cams` query, `reconnect()`; one running stream per group, fan-out |
| `server/proxy/cameraList.ts` (new) | `readProxyList()`, one request per group at a time; `entryOf()` |
| `server/proxy/names.ts`, `server/routes/proxy.ts` | read through `cameraList.ts` |
| `server/tls/fingerprint.ts` (new) | normalize, format, compute SHA-256 fingerprints |
| `server/tls/siteCa.ts` (new) | `fetchPinnedCa()`, `siteCaDispatcher()`, `fetchWith()` |
| `server/cameraImport.ts` (new) | the generator's logic: input + secrets, reading proxies, building entries, diff, `runCamerasConfig()` |
| `scripts/cameras-config.ts` (new) | CLI wrapper |
| `test/proxy/fakeProxy.ts` | `?cam=` list filter, HTTPS mode, `/tls/ca.pem`, `cameraTls` |
| `test/fixtures/site-ca/` (new) | test-only CA, leaves and `make.sh` |
| `test/fakeProxyMulti.test.ts`, `test/proxyGroups.test.ts`, `test/proxyGroupStream.test.ts`, `test/proxyCameraList.test.ts`, `test/siteCa.test.ts`, `test/cameraImport.test.ts`, `test/camerasConfigCli.test.ts` (new) | tests |
| `e2e/sims.ts`, `e2e/realProxy.ts`, `e2e/env.ts`, `e2e/cameras.json`, `e2e/realProxy.spec.ts`, `e2e/shell.spec.ts` | Silo + Loft on one real cam-proxy |
| `scripts/livestack/start-multi-stack.sh`, `scripts/livestack/check-multi.sh` (new), `scripts/livestack/stop-stack.sh`, `docs/livestack.md` | the multi-camera live stack |
| `README.md`, `CHANGELOG.md`, `.gitignore`, `package.json`, `tsconfig.check.json` | docs, ignore the input file, undici, type-check `scripts/*.ts` |

---

### Task 1: The fake proxy serves several cameras on one filtered stream

**Files:**
- Modify: `test/proxy/fakeProxy.ts` (the `streams`/`streamTypes` bookkeeping, `push`, `GET /api/stream`)
- Test: `test/fakeProxyMulti.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: the fake's `GET /api/stream` honours `?cam=<id>[,<id>…]` (split on `,`) in replay and live pushes, like the multi-camera cam-proxy (spec §6.2); `fake.camFilter: boolean` (default `true`; tests set `false` to get every camera's messages regardless of `?cam=`, so cams's own filter can be tested). `fake.cameraNames` / `fake.cameraAddresses` with several ids already make `/api/cameras` list several cameras.

- [ ] **Step 1: Write the failing test**

```ts
// test/fakeProxyMulti.test.ts
// The fake cam-proxy as a multi-camera host (cam-proxy spec 2026-10-05
// §6.2): one stream, `?cam=a,b` filters to those cameras.
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

let fake: FakeProxy | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

// Reads `count` data frames' `cam` from an SSE response.
async function cams(res: Response, count: number): Promise<string[]> {
  const out: string[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    for (const m of buf.matchAll(/^data: (.*)$/gm)) out.push(JSON.parse(m[1]).cam);
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
    if (out.length >= count) break;
  }
  return out;
}

describe('fake proxy with several cameras', () => {
  it('lists every camera', async () => {
    fake = await startFakeProxy();
    fake.cameraNames.set('cam3', 'Gate');
    const list = (await (await fetch(`${fake.url}/api/cameras`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } })).json()) as { id: string }[];
    expect(list.map((c) => c.id)).toEqual(['cam1', 'cam3']);
  });

  it('filters the stream to the cameras in ?cam=, replay and live', async () => {
    fake = await startFakeProxy();
    fake.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    fake.push({ cam: 'cam2', type: 'clip', data: { clipId: 2 } });
    fake.push({ cam: 'cam3', type: 'clip', data: { clipId: 3 } });
    const ctl = new AbortController();
    const res = await fetch(`${fake.url}/api/stream?since=0&cam=cam1,cam3`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` }, signal: ctl.signal });
    const got = cams(res, 3);
    setTimeout(() => {
      fake!.push({ cam: 'cam2', type: 'clip', data: { clipId: 4 } });
      fake!.push({ cam: 'cam3', type: 'clip', data: { clipId: 5 } });
    }, 50);
    expect(await got).toEqual(['cam1', 'cam3', 'cam3']);
    ctl.abort();
  });

  it('still takes a single ?cam=', async () => {
    fake = await startFakeProxy();
    fake.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    fake.push({ cam: 'cam2', type: 'clip', data: { clipId: 2 } });
    const ctl = new AbortController();
    const res = await fetch(`${fake.url}/api/stream?since=0&cam=cam2`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` }, signal: ctl.signal });
    expect(await cams(res, 1)).toEqual(['cam2']);
    ctl.abort();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fakeProxyMulti.test.ts`
Expected: FAIL in "filters the stream…" (`['cam1', 'cam2', 'cam3']` instead of `['cam1', 'cam3', 'cam3']`); "lists every camera" passes already.

- [ ] **Step 3: Implement the filter**

In `test/proxy/fakeProxy.ts` replace `const streamTypes = new Map<Response, string[] | undefined>();` with:

```ts
  // Like the real one: live pushes honour ?types and ?cam (a list, spec 2026-10-05 §6.2).
  const streamFilters = new Map<Response, { types?: string[]; cams?: Set<string> }>();
  const wanted = (f: { types?: string[]; cams?: Set<string> } | undefined, m: FakeMessage) => (!f?.types || f.types.includes(m.type)) && (!fake.camFilter || !f?.cams || f.cams.has(m.cam));
```

Add `camFilter: boolean; // tests: false = ignore ?cam= and send every camera's messages` to the `FakeProxy` interface and `camFilter: true,` to the initial object.

In `push(m)` replace the loop body with:

```ts
      for (const res of streams) if (wanted(streamFilters.get(res), msg)) write(res, msg);
```

In `app.get('/api/stream', …)` after the `types` line add

```ts
    const camList = typeof req.query.cam === 'string' && req.query.cam ? new Set(req.query.cam.split(',')) : undefined;
    const filter = { types, cams: camList };
```

replace the replay condition `(!types || types.includes(m.type))` with `wanted(filter, m)`, replace `streamTypes.set(res, types);` with `streamFilters.set(res, filter);` and `streamTypes.delete(res);` with `streamFilters.delete(res);`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fakeProxyMulti.test.ts test/proxyStream.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add test/proxy/fakeProxy.ts test/fakeProxyMulti.test.ts
git commit -m "test: fake cam-proxy filters its stream by a list of cameras"
```

---

### Task 2: Proxy groups, one client per proxy, the Archive on the group

**Files:**
- Create: `server/proxy/groupKey.ts`, `server/proxy/groups.ts`
- Modify: `server/cameraRegistry.ts` (`loadCameras` → `parseCameras`, `allCameras`, group check), `server/proxy/client.ts` (clients per group, `proxyClientFor`), `server/proxy/archive.ts:18-45` (`archiveProxies`, `ArchiveProxy.group`)
- Test: `test/proxyGroups.test.ts` (new); existing `test/archiveRoutes.test.ts` must stay green

**Interfaces:**
- Consumes: `CameraConfig.proxy {url, token, adminToken?, camera?}` (existing).
- Produces:
  - `proxyGroupKey(p: { url: string; token: string }): string`
  - `interface ProxyGroup { key: string; url: string; token: string; members: string[]; remoteOf: ReadonlyMap<string, string> }` (`members`: every cams camera on the proxy in config order, switched on or off; `remoteOf`: cams id → proxy id)
  - `proxyGroups(): ProxyGroup[]` (memoized per registry list), `groupOf(id: string): ProxyGroup | undefined`, `activeMembers(g: ProxyGroup): string[]`, `remoteIds(g: ProxyGroup, members?: string[]): string[]` (sorted, unique)
  - `allCameras(): readonly CameraConfig[]`, `parseCameras(parsed: unknown, label: string): CameraConfig[]` (throws like `loadCameras`)
  - `proxyClientFor(id: string): ProxyClient | undefined` (the group's client, even when switched off); `getProxyClient(id)` unchanged in meaning
  - `ArchiveProxy.group: ProxyGroup`

- [ ] **Step 1: Write the failing test**

```ts
// test/proxyGroups.test.ts
// Proxy groups (cam-proxy spec 2026-10-05 §12.1): the entries with the same
// proxy url + token are one proxy, with one client, one stream and one
// Archive entry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCameras, setCameras, type CameraConfig } from '../server/cameraRegistry';
import { getProxyClient, proxyClientFor, resetProxyClients } from '../server/proxy/client';
import { activeMembers, groupOf, proxyGroups, remoteIds } from '../server/proxy/groups';
import { archiveProxies } from '../server/proxy/archive';
import { loadProxyState, setProxyEnabled } from '../server/proxyState';

const T = 'a'.repeat(40), T2 = 'b'.repeat(40), ADMIN = 'c'.repeat(40);
const cam = (id: string, proxy?: CameraConfig['proxy']): CameraConfig => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', ...(proxy && { proxy }) });
const file = (body: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'cams-groups-')), 'cameras.json');
  writeFileSync(f, JSON.stringify(body));
  return f;
};

beforeEach(() => {
  process.env.PROXY_STATE_FILE = join(mkdtempSync(join(tmpdir(), 'cams-groups-state-')), 'proxy-state.json');
  loadProxyState();
  resetProxyClients();
});
afterEach(() => {
  setCameras([]);
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

describe('proxy groups', () => {
  it('groups entries by url and token, in config order', () => {
    setCameras([
      cam('den', { url: 'http://a:8480', token: T, camera: 'cam1' }),
      cam('shed'),
      cam('cam2', { url: 'http://b:8480', token: T }),
      cam('barn', { url: 'http://a:8480/', token: T }),
      cam('gate', { url: 'http://a:8480', token: T2 }),
    ]);
    const gs = proxyGroups();
    expect(gs.map((g) => g.members)).toEqual([['den', 'barn'], ['cam2'], ['gate']]);
    expect(groupOf('barn')).toBe(gs[0]);
    expect([...gs[0].remoteOf]).toEqual([['den', 'cam1'], ['barn', 'barn']]);
    expect(remoteIds(gs[0])).toEqual(['barn', 'cam1']);
    expect(groupOf('shed')).toBeUndefined();
  });

  it('has one client per proxy, and none for a switched-off camera', async () => {
    setCameras([cam('den', { url: 'http://a:8480', token: T, camera: 'cam1' }), cam('barn', { url: 'http://a:8480', token: T })]);
    expect(getProxyClient('den')).toBe(getProxyClient('barn'));
    await setProxyEnabled('barn', false);
    expect(getProxyClient('barn')).toBeUndefined();
    expect(proxyClientFor('barn')).toBe(getProxyClient('den'));
    expect(activeMembers(groupOf('den')!)).toEqual(['den']);
  });

  it('builds the Archive proxies from the same group objects (spec §12.4)', async () => {
    setCameras([cam('den', { url: 'http://a:8480', token: T, camera: 'cam1' }), cam('barn', { url: 'http://a:8480', token: T }), cam('cam2', { url: 'http://b:8480', token: T, camera: 'cam1' })]);
    const ps = archiveProxies();
    expect(ps.map((p) => [p.via, p.cams])).toEqual([['den', ['den', 'barn']], ['cam2', ['cam2']]]);
    expect(ps[0].group).toBe(groupOf('den'));
    expect([...ps[0].toCams]).toEqual([['cam1', 'den'], ['barn', 'barn']]);
    await setProxyEnabled('den', false);
    expect(archiveProxies()[0].via).toBe('barn'); // as today: the first camera that uses it
  });
});

describe('registry checks for a group', () => {
  const p = { url: 'http://a:8480', token: T };
  const entry = (id: string, proxy: object) => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy });

  it('accepts an adminToken on only some entries (e2e/cameras.json: cam1 and barn)', () => {
    expect(loadCameras(file([entry('den', { ...p, adminToken: ADMIN }), entry('barn', p)]))).toHaveLength(2);
    expect(() => loadCameras('e2e/cameras.json')).not.toThrow();
  });

  it('refuses two different adminTokens for one proxy, naming both entries', () => {
    expect(() => loadCameras(file([entry('den', { ...p, adminToken: ADMIN }), entry('x', { url: 'http://b:1', token: T }), entry('barn', { ...p, adminToken: 'd'.repeat(40) })]))).toThrow(
      'camera registry entries 0 ("den") and 2 ("barn"): same cam-proxy (url and token) but different adminToken',
    );
  });

  it('loads the Pi’s one-camera shape unchanged', () => {
    const pi = { id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'cams', password: 'pw', proxy: { url: 'http://127.0.0.1:8480', token: T, adminToken: ADMIN } };
    const [c] = loadCameras(file([pi]));
    expect(c).toEqual({ ...pi });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxyGroups.test.ts`
Expected: FAIL: `Cannot find module '../server/proxy/groups'`.

- [ ] **Step 3: Write the group key and groups**

```ts
// server/proxy/groupKey.ts
// One cam-proxy, as cams knows it: its URL (trailing slashes dropped) and the
// client token cams uses there (cam-proxy spec 2026-10-05 §12.1). The key
// holds the token: never log it.
export const proxyGroupKey = (p: { url: string; token: string }): string => `${p.url.replace(/\/+$/, '')}\u0000${p.token}`;
```

```ts
// server/proxy/groups.ts
import { allCameras, proxyActive, type CameraConfig } from '../cameraRegistry';
import { proxyGroupKey } from './groupKey';

// The cams cameras that share one cam-proxy (cam-proxy spec 2026-10-05
// §12.1, §12.4): one client, one event stream and one Archive entry per
// group. Built from the registry, so it changes only with setCameras().

export interface ProxyGroup {
  key: string; // proxyGroupKey: holds the token, never logged
  url: string;
  token: string;
  members: string[]; // every cams camera on this proxy, config order, switched on or off
  remoteOf: ReadonlyMap<string, string>; // cams id → the proxy's id for it
}

let built: { from: readonly CameraConfig[]; groups: ProxyGroup[] } | undefined;

export function proxyGroups(): ProxyGroup[] {
  const cams = allCameras();
  if (built?.from === cams) return built.groups;
  const byKey = new Map<string, ProxyGroup & { remoteOf: Map<string, string> }>();
  for (const c of cams) {
    if (!c.proxy) continue;
    const key = proxyGroupKey(c.proxy);
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { key, url: c.proxy.url.replace(/\/+$/, ''), token: c.proxy.token, members: [], remoteOf: new Map() }));
    g.members.push(c.id);
    g.remoteOf.set(c.id, c.proxy.camera ?? c.id);
  }
  built = { from: cams, groups: [...byKey.values()] };
  return built.groups;
}

export const groupOf = (id: string): ProxyGroup | undefined => proxyGroups().find((g) => g.members.includes(id));

// The members whose proxy is switched on (Settings), config order.
export const activeMembers = (g: ProxyGroup): string[] => g.members.filter((id) => proxyActive(id));

// The proxy's ids for these members, sorted and unique: the stream's ?cam=.
export const remoteIds = (g: ProxyGroup, members: string[] = activeMembers(g)): string[] => [...new Set(members.map((id) => g.remoteOf.get(id)!))].sort();
```

- [ ] **Step 4: Split `parseCameras` out of `loadCameras`, add `allCameras` and the group check**

In `server/cameraRegistry.ts`:
- add `import { proxyGroupKey } from './proxy/groupKey';`
- in `loadCameras`, replace everything after `JSON.parse` succeeded (from `if (!Array.isArray(parsed))` to the end of the `return parsed.map(…)`) with `return parseCameras(parsed, basename(file));`
- move that code into `export function parseCameras(parsed: unknown, label: string): CameraConfig[]`, using `label` where it used `basename(file)`, and end it with:

```ts
  const list = parsed.map(/* the existing per-entry mapper, unchanged */);
  checkProxyGroups(list);
  return list;
}

// Entries with the same proxy url + token are one cam-proxy (spec
// 2026-10-05 §12.1): their admin tokens can't disagree. An entry without
// one keeps no sign-in link, as before.
function checkProxyGroups(list: CameraConfig[]): void {
  const admin = new Map<string, { i: number; id: string; token: string }>();
  list.forEach((c, i) => {
    if (!c.proxy?.adminToken) return;
    const key = proxyGroupKey(c.proxy);
    const first = admin.get(key);
    if (!first) return void admin.set(key, { i, id: c.id, token: c.proxy.adminToken });
    if (first.token !== c.proxy.adminToken) {
      throw new Error(`camera registry entries ${first.i} ("${first.id}") and ${i} ("${c.id}"): same cam-proxy (url and token) but different adminToken`);
    }
  });
}
```

- add next to `getCamera`:

```ts
// Every configured camera, config order (the same array until setCameras).
export function allCameras(): readonly CameraConfig[] {
  return cameras;
}
```

- [ ] **Step 5: One client per group**

In `server/proxy/client.ts` replace the block from `// One client per camera for the life of the process` through the end of `getProxyClient` with:

```ts
// One client per cam-proxy (group: url + token) for the life of the process.
const clients = new Map<string, ProxyClient>();

// The group's client whether or not the camera's proxy is switched on (the
// Settings page's proxy info asks even then).
export function proxyClientFor(id: string): ProxyClient | undefined {
  const g = groupOf(id);
  if (!g) return undefined;
  let client = clients.get(g.key);
  if (!client) clients.set(g.key, (client = new ProxyClient({ url: g.url, token: g.token })));
  return client;
}

// Undefined for a camera without a cam-proxy or with it switched off.
export function getProxyClient(id: string): ProxyClient | undefined {
  return proxyEnabled(id) ? proxyClientFor(id) : undefined;
}
```

and add `import { groupOf } from './groups';` (keep `getCamera` for `proxyCameraId`).

- [ ] **Step 6: The Archive from the groups**

In `server/proxy/archive.ts` replace the imports of `getCamera, listProxied` and the body of `archiveProxies` (lines 1-35):

```ts
import { getProxyClient, proxyCameraId, type ProxyClient } from './client';
import { activeMembers, proxyGroups, type ProxyGroup } from './groups';
import { LABEL, QUALITIES } from '../archiveRules';

// (comment block unchanged)

export interface ArchiveProxy {
  via: string; // the cams camera id the proxy is reached through
  client: ProxyClient;
  cams: string[]; // the cams cameras that use this proxy
  toCams: Map<string, string>; // the proxy's camera id → cams's
  group: ProxyGroup; // the same object as the event stream's (spec 2026-10-05 §12.4)
}

// The proxies in use (a switched-off camera is left out, as everywhere).
export function archiveProxies(): ArchiveProxy[] {
  const out: ArchiveProxy[] = [];
  for (const group of proxyGroups()) {
    const cams = activeMembers(group);
    const client = cams.length ? getProxyClient(cams[0]) : undefined;
    if (!client) continue;
    const toCams = new Map<string, string>();
    for (const id of cams) {
      const remote = group.remoteOf.get(id)!;
      if (!toCams.has(remote)) toCams.set(remote, id);
    }
    out.push({ via: cams[0], client, cams, toCams, group });
  }
  return out;
}
```

`proxyCameraId` stays imported if other code in the file uses it (`proxyOfCamera` does).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/proxyGroups.test.ts test/archiveRoutes.test.ts test/proxySwitch.test.ts test/cameraRegistry.test.ts test/cameraAddress.test.ts`
Expected: PASS (all).

- [ ] **Step 8: Commit**

```bash
git add server/proxy/groupKey.ts server/proxy/groups.ts server/cameraRegistry.ts server/proxy/client.ts server/proxy/archive.ts test/proxyGroups.test.ts
git commit -m "feat: proxy groups: one client and one Archive entry per cam-proxy"
```

---

### Task 3: One upstream stream per proxy, fanned out to its cameras

**Files:**
- Modify: `server/proxy/stream.ts` (whole file below the `TYPES` constants)
- Modify: `test/proxyStream.test.ts` (ProxyStream-level assertions; the "review #5" test moves)
- Test: `test/proxyGroupStream.test.ts` (new)

**Interfaces:**
- Consumes: `ProxyGroup`, `proxyGroups()`, `groupOf()`, `activeMembers()`, `remoteIds()` (Task 2); `getProxyClient()`.
- Produces:
  - `ProxyStream` constructor `(label: string, client: ProxyClient, o: StreamOptions)`; `StreamOptions.cams?: () => string[]` (replaces `remoteCam`); emits `'message' {remote: string | null, type: string, data: Record<string, unknown>}` and `'state' boolean`; new `reconnect(): void` (keeps the last id).
  - Unchanged signatures: `startProxyStreams(o?)`, `startProxyStream(cam)`, `stopProxyStream(cam)`, `stopProxyStreams(final?)`, `proxyStates(): {cam, up}[]`, `proxyHub` events `'message' {cam, type, data}` and `'state' {cam, up}` (per cams camera).

- [ ] **Step 1: Write the failing test**

```ts
// test/proxyGroupStream.test.ts
// One upstream event stream per cam-proxy (cam-proxy spec 2026-10-05 §12.2),
// fanned out to the cams cameras mapped from each message's `cam`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras, type CameraConfig } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { proxyHub, proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { loadProxyState } from '../server/proxyState';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const OPTS = { backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 };
const cam = (id: string, proxy?: CameraConfig['proxy']): CameraConfig => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', ...(proxy && { proxy }) });
const fakes: FakeProxy[] = [];
let got: { cam: string; type: string; data: Record<string, unknown> }[];
const onMessage = (m: { cam: string; type: string; data: Record<string, unknown> }) => got.push(m);

beforeEach(() => {
  process.env.PROXY_STATE_FILE = join(mkdtempSync(join(tmpdir(), 'cams-gs-')), 'proxy-state.json');
  loadProxyState();
  resetProxyClients();
  got = [];
  proxyHub.on('message', onMessage);
});
afterEach(async () => {
  proxyHub.off('message', onMessage);
  stopProxyStreams();
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  setCameras([]);
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

async function fake(): Promise<FakeProxy> {
  const f = await startFakeProxy();
  fakes.push(f);
  return f;
}
const streamAsks = (f: FakeProxy) => f.requests.filter((r) => r.path === '/api/stream');
const allUp = (ids: string[]) => ids.every((id) => proxyStates().find((s) => s.cam === id)?.up);

describe('one stream per proxy', () => {
  it('opens one upstream for two cameras, asking for both ids', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('shed'), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    expect(a.streamConnections()).toBe(1);
    expect(streamAsks(a).at(-1)?.query.cam).toBe('barn,cam1');
    expect(proxyStates()).toEqual([{ cam: 'den', up: true }, { cam: 'barn', up: true }]);
  });

  it('fans each message out to the camera mapped from its cam', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    a.push({ cam: 'barn', type: 'clip', data: { clipId: 2 } });
    await expect.poll(() => got.length).toBe(2);
    expect(got.map((m) => [m.cam, m.data.clipId])).toEqual([['den', 1], ['barn', 2]]);
  });

  it('drops cameras it doesn’t map', async () => {
    const a = await fake();
    a.camFilter = false; // sends every camera, so cams's own filter is what's tested
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam9', type: 'clip', data: { clipId: 9 } });
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    await expect.poll(() => got.length).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((m) => m.cam)).toEqual(['den']);
  });

  it('sends a reset and the state to every camera of the proxy', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    await expect.poll(() => got.length).toBe(1);
    a.oldestId = 100; // the proxy lost our place
    a.dropStreams();
    await expect.poll(() => got.filter((m) => m.type === 'reset').map((m) => m.cam).sort()).toEqual(['barn', 'den']);
    a.offline = true;
    a.dropStreams();
    await expect.poll(() => proxyStates().every((s) => !s.up)).toBe(true);
  });

  it('resumes both cameras after a drop, missing nothing, doubling nothing', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    await expect.poll(() => got.length).toBe(1);
    a.dropStreams();
    a.push({ cam: 'barn', type: 'clip', data: { clipId: 2 } }); // while disconnected
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 3 } });
    await expect.poll(() => got.length).toBe(3);
    await new Promise((r) => setTimeout(r, 150));
    expect(got.map((m) => [m.cam, m.data.clipId])).toEqual([['den', 1], ['barn', 2], ['den', 3]]);
  });

  it('keeps today’s one stream per one-camera proxy (the cluster: the Pi’s and its own)', async () => {
    const [a, b] = [await fake(), await fake()];
    setCameras([cam('cam1', { url: a.url, token: FAKE_TOKEN }), cam('cam2', { url: b.url, token: FAKE_TOKEN, camera: 'cam1' })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['cam1', 'cam2'])).toBe(true);
    expect([a.streamConnections(), b.streamConnections()]).toEqual([1, 1]);
    expect([streamAsks(a).at(-1)?.query.cam, streamAsks(b).at(-1)?.query.cam]).toEqual(['cam1', 'cam1']);
  });
});

describe('the Settings switch on a shared proxy', () => {
  const put = (id: string, enabled: boolean) => request(createApp()).put(`/api/cameras/${id}/proxy`).set('Cookie', auth).send({ enabled });

  it('re-subscribes on the switch, and closes with the last camera', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    const states: { cam: string; up: boolean }[] = [];
    const onState = (s: { cam: string; up: boolean }) => states.push(s);
    proxyHub.on('state', onState);
    try {
      expect((await put('barn', false)).status).toBe(200);
      await expect.poll(() => streamAsks(a).at(-1)?.query.cam).toBe('cam1');
      await expect.poll(() => a.streamConnections()).toBe(1);
      expect(states).toContainEqual({ cam: 'barn', up: false });
      expect(proxyStates()).toEqual([{ cam: 'den', up: true }]);
      expect((await put('den', false)).status).toBe(200);
      await expect.poll(() => a.streamConnections()).toBe(0);
      expect(proxyStates()).toEqual([]);
      expect((await put('barn', true)).status).toBe(200);
      await expect.poll(() => allUp(['barn'])).toBe(true);
      expect(streamAsks(a).at(-1)?.query.cam).toBe('barn');
      expect(a.streamConnections()).toBe(1);
    } finally {
      proxyHub.off('state', onState);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxyGroupStream.test.ts`
Expected: FAIL: "opens one upstream…" sees `streamConnections()` 2 and `query.cam` undefined.

- [ ] **Step 3: Rewrite the stream for groups**

In `server/proxy/stream.ts`:

Imports become:

```ts
import { EventEmitter } from 'events';
import { listProxied, proxyActive } from '../cameraRegistry';
import { logger } from '../logger';
import { getProxyClient, ProxyError, type ProxyClient } from './client';
import { activeMembers, groupOf, proxyGroups, remoteIds, type ProxyGroup } from './groups';
```

Header comment: replace the first block with

```ts
// One upstream subscription to a cam-proxy's event stream (SSE), shared by
// every cams camera on that proxy (cam-proxy spec 2026-10-05 §12.2). It
// resumes from the last id after a drop, starts over on `reset`, and
// reconnects with backoff while the proxy is away. Emits:
//   'message' {remote, type, data}   remote: the message's `cam` (the proxy's id), null when it has none; type 'reset' when the proxy lost our place
//   'state'   up (boolean)
```

`StreamOptions`: delete `remoteCam`; add

```ts
  cams?: () => string[]; // the proxy's camera ids to ask for (?cam=a,b), read at every connect; empty: all
```

Class changes:
- constructor `(readonly label: string, private readonly client: ProxyClient, private readonly o: StreamOptions = {})` (the `cam` field becomes `label`, the proxy's host, for logs).
- add `private gen = 0;`
- add

```ts
  // The camera list changed (a camera switched on or off): ask again at
  // once, from the last id, without reporting down in between.
  reconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.delay = this.o.backoffMinMs ?? 1000;
    this.abort?.abort();
    void this.connect();
  }
```

- in `connect()`: first line after the `stopped` check `const gen = ++this.gen;`; the `open` query becomes

```ts
      const cams = this.o.cams?.() ?? [];
      const res = await this.client.open('/api/stream', { types: this.types.join(','), since: this.lastId, cam: cams.length ? cams.join(',') : undefined }, { signal: abort.signal, idleMs: this.o.idleMs ?? 45_000 });
```

  the catch starts with `if (this.stopped || gen !== this.gen) return;`; the recursive `return void this.connect();` (type refused) stays; every `cameraId: this.cam` in logs becomes `proxy: this.label`.
- in `frame()`: the reset branch emits `this.emit('message', { remote: null, type: 'reset', data: {} });`; delete the "A proxy can serve several cameras" filter; the last line becomes

```ts
    this.emit('message', { remote: typeof parsed.cam === 'string' ? parsed.cam : null, type: event, data: parsed });
```

Replace everything from `// All cameras' streams, for the browser relay` to the end of the file with:

```ts
// Every cams camera's messages and states, for the browser relay
// (routes/events.ts), the names and the recordings cache: per cams camera.
export const proxyHub = new EventEmitter();
proxyHub.setMaxListeners(0);

interface Running {
  group: ProxyGroup;
  stream: ProxyStream;
  members: string[]; // the cams cameras it serves now (switched on), config order
}
const running = new Map<string, Running>(); // by group key

let options: StreamOptions = {};
let shuttingDown = false; // set by stopProxyStreams(true) at SIGTERM

const camList = (r: Running) => remoteIds(r.group, r.members).join(',');

function fanOut(r: Running, m: { remote: string | null; type: string; data: Record<string, unknown> }): void {
  const to = m.type === 'reset' || m.remote === null ? r.members : r.members.filter((id) => r.group.remoteOf.get(id) === m.remote);
  for (const cam of to) proxyHub.emit('message', { cam, type: m.type, data: m.data });
}

function run(group: ProxyGroup, members: string[]): void {
  const client = getProxyClient(members[0]);
  if (!client) return;
  const r: Running = { group, members, stream: undefined as unknown as ProxyStream };
  r.stream = new ProxyStream(client.host(), client, { ...options, cams: () => remoteIds(group, r.members) });
  r.stream.on('message', (m) => fanOut(r, m));
  r.stream.on('state', (up: boolean) => {
    for (const cam of r.members) proxyHub.emit('state', { cam, up });
  });
  running.set(group.key, r);
  r.stream.start();
}

export function startProxyStreams(o: StreamOptions = {}): void {
  stopProxyStreams();
  shuttingDown = false;
  options = o;
  for (const g of proxyGroups()) {
    const members = activeMembers(g);
    if (members.length) run(g, members);
  }
}

// One camera's proxy switched back on: it joins its proxy's stream (opened
// if it was the only one).
export function startProxyStream(cam: string): void {
  if (shuttingDown || !proxyActive(cam)) return;
  const g = groupOf(cam);
  if (!g) return;
  const r = running.get(g.key);
  if (!r) return run(g, [cam]);
  if (r.members.includes(cam)) return;
  const before = camList(r);
  r.members = activeMembers(g).filter((id) => id === cam || r.members.includes(id));
  if (r.stream.up()) proxyHub.emit('state', { cam, up: true });
  if (camList(r) !== before) r.stream.reconnect();
}

// One camera's proxy switched off: it leaves the stream (closed with the
// last one). Browsers hear that its proxy is gone and reload its events
// from the camera.
export function stopProxyStream(cam: string): void {
  const g = groupOf(cam);
  const r = g && running.get(g.key);
  if (!r || !r.members.includes(cam)) return;
  const before = camList(r);
  r.members = r.members.filter((id) => id !== cam);
  proxyHub.emit('state', { cam, up: false });
  if (!r.members.length) {
    r.stream.removeAllListeners();
    r.stream.stop();
    running.delete(g!.key);
    return;
  }
  if (camList(r) !== before) r.stream.reconnect();
}

// `final`: the process is shutting down, and no stream may start again.
export function stopProxyStreams(final = false): void {
  if (final) shuttingDown = true;
  for (const r of running.values()) r.stream.stop();
  running.clear();
}

export function proxyStates(): { cam: string; up: boolean }[] {
  const up = new Map<string, boolean>();
  for (const r of running.values()) for (const cam of r.members) up.set(cam, r.stream.up());
  return listProxied().filter((cam) => up.has(cam)).map((cam) => ({ cam, up: up.get(cam)! }));
}
```

- [ ] **Step 4: Update the ProxyStream-level tests**

In `test/proxyStream.test.ts`, inside `describe('ProxyStream (upstream)', …)` only: every `toMatchObject({ cam: 'den', type: …` on a `got[…]` becomes `toMatchObject({ remote: 'den', type: …`, and the reset test's expected message `{ cam: 'den', type: 'reset', data: {} }` becomes `{ remote: null, type: 'reset', data: {} }`. Delete the test "passes on only its own camera’s messages when a proxy serves several (review #5)" (the fan-out tests in `test/proxyGroupStream.test.ts` replace it). The browser-relay `describe` below it is unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/proxyGroupStream.test.ts test/proxyStream.test.ts test/proxySwitch.test.ts test/cameraAddress.test.ts test/cameraNameRoutes.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add server/proxy/stream.ts test/proxyStream.test.ts test/proxyGroupStream.test.ts
git commit -m "feat: one event stream per cam-proxy, fanned out to its cameras"
```

---

### Task 4: One camera-list read per proxy (names, addresses, proxy info)

**Files:**
- Create: `server/proxy/cameraList.ts`
- Modify: `server/proxy/names.ts:31-40` (`readProxyEntry`), `server/routes/proxy.ts:58-74` (`proxyInfo`)
- Test: `test/proxyCameraList.test.ts` (new)

**Interfaces:**
- Consumes: `groupOf()`, `proxyClientFor()`, `proxyCameraId()`.
- Produces:
  - `interface ProxyCameraEntry { id?: unknown; name?: unknown; address?: unknown; publicUrl?: unknown; tls?: unknown; error?: unknown }`
  - `readProxyList(id: string, timeoutMs: number): Promise<ProxyCameraEntry[]>` (rejects with `ProxyError` like `ProxyClient.json`; requests for one group within 2 s share one answer)
  - `entryOf(id: string, list: ProxyCameraEntry[]): ProxyCameraEntry | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// test/proxyCameraList.test.ts
// The proxy's camera list (names, addresses, its web address) is read once
// per proxy, not once per cams camera.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { cameraName, setCameras, type CameraConfig } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { readProxyList } from '../server/proxy/cameraList';
import { proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import '../server/proxy/names';
import { loadProxyState } from '../server/proxyState';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const cam = (id: string, proxy: CameraConfig['proxy']): CameraConfig => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy });
let a: FakeProxy;
const listReads = () => a.requests.filter((r) => r.path === '/api/cameras').length;

beforeEach(async () => {
  process.env.PROXY_STATE_FILE = join(mkdtempSync(join(tmpdir(), 'cams-list-')), 'proxy-state.json');
  loadProxyState();
  a = await startFakeProxy();
  a.cameraNames.set('barn', 'Big Barn');
  a.publicUrl = 'http://proxy.example:8480';
  setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
  resetProxyClients();
});
afterEach(async () => {
  stopProxyStreams();
  await a.stop();
  setCameras([]);
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

describe('camera list per proxy', () => {
  it('shares one request between cameras asking at once', async () => {
    const [x, y] = await Promise.all([readProxyList('den', 3000), readProxyList('barn', 3000)]);
    expect(x).toBe(y);
    expect(listReads()).toBe(1);
  });

  it('reads names for both cameras with one request when the stream comes up', async () => {
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
    await expect.poll(() => [cameraName('den'), cameraName('barn')]).toEqual(['Den', 'Big Barn']);
    expect(proxyStates().every((s) => s.up)).toBe(true);
    expect(listReads()).toBe(1);
  });

  it('answers the Settings proxy info from the same list, per camera', async () => {
    const r = await request(createApp()).get('/api/cameras/barn/proxy/info').set('Cookie', auth);
    expect(r.body).toEqual({ reachable: true, webUrl: 'http://proxy.example:8480' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxyCameraList.test.ts`
Expected: FAIL: `Cannot find module '../server/proxy/cameraList'`.

- [ ] **Step 3: Write `cameraList.ts`**

```ts
// server/proxy/cameraList.ts
import { groupOf } from './groups';
import { ProxyError, proxyCameraId, proxyClientFor, type ProxyClient } from './client';

// The proxy's camera list (GET /api/cameras: every camera it serves, with
// its name, address, web address and, with a site CA, its TLS state). One
// request per proxy at a time: requests within FRESH_MS share one answer, so
// four cameras coming up together ask once (cam-proxy spec 2026-10-05 §12.2).

export interface ProxyCameraEntry { id?: unknown; name?: unknown; address?: unknown; publicUrl?: unknown; tls?: unknown; error?: unknown }

const FRESH_MS = 2000;
// Per client: resetProxyClients() starts every proxy afresh.
const recent = new WeakMap<ProxyClient, { at: number; list: Promise<ProxyCameraEntry[]> }>();

// Asked even while the camera's proxy is switched off (the Settings page).
export function readProxyList(id: string, timeoutMs: number): Promise<ProxyCameraEntry[]> {
  const client = groupOf(id) && proxyClientFor(id);
  if (!client) return Promise.reject(new ProxyError('proxy_unreachable', 'the camera has no cam-proxy'));
  const hit = recent.get(client);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.list;
  const list = client.json<unknown>('/api/cameras', undefined, { timeoutMs }).then((l) => (Array.isArray(l) ? (l as ProxyCameraEntry[]) : []));
  const entry = { at: Date.now(), list };
  recent.set(client, entry);
  list.catch(() => {
    if (recent.get(client) === entry) recent.delete(client); // a failure isn't shared with later callers
  });
  return list;
}

// This cams camera's entry (by the proxy's id for it).
export function entryOf(id: string, list: ProxyCameraEntry[]): ProxyCameraEntry | undefined {
  const remote = proxyCameraId(id);
  return list.find((c) => c?.id === remote);
}
```

- [ ] **Step 4: Read through it in names and proxy info**

In `server/proxy/names.ts` replace `readProxyEntry` with:

```ts
// The camera's entry in the proxy's camera list (no answer, no entry: undefined).
async function readProxyEntry(id: string, timeoutMs: number): Promise<ProxyCameraEntry | undefined> {
  if (!getProxyClient(id)) return undefined;
  try {
    return entryOf(id, await readProxyList(id, timeoutMs));
  } catch (err) {
    logger.debug({ cameraId: id, message: (err as Error).message }, 'proxy_name_unread');
    return undefined;
  }
}
```

with `import { entryOf, readProxyList, type ProxyCameraEntry } from './cameraList';` and `proxyCameraId` dropped from the `./client` import if unused.

In `server/routes/proxy.ts` replace the first lines of `proxyInfo` (the signature and the `try { list = … }` part) so it reads:

```ts
async function proxyInfo(id: string): Promise<{ reachable: boolean; webUrl: string | null }> {
  let list: ProxyCameraEntry[];
  try {
    list = await readProxyList(id, 3000);
  } catch {
    return { reachable: false, webUrl: null };
  }
  // It answered: reachable. A link only for this camera's own entry.
  const mine = entryOf(id, list);
```

(the rest unchanged), update both callers to `proxyInfo(c.id)` / `proxyInfo(id)`, and add `import { entryOf, readProxyList, type ProxyCameraEntry } from '../proxy/cameraList';`. The login-link's admin client (`new ProxyClient({ url: proxy.url, token: proxy.adminToken }, …)`) is unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/proxyCameraList.test.ts test/cameraNameRoutes.test.ts test/cameraAddress.test.ts test/proxyRoutes.test.ts test/proxySwitch.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add server/proxy/cameraList.ts server/proxy/names.ts server/routes/proxy.ts test/proxyCameraList.test.ts
git commit -m "feat: read a cam-proxy's camera list once for all its cameras"
```

---

### Task 5: Test site CA fixtures and fingerprints

**Files:**
- Create: `test/fixtures/site-ca/make.sh`, the PEM files it writes (`ca-a.pem`, `ca-a.key`, `ca-b.pem`, `ca-b.key`, `proxy-a.pem`, `proxy-a.key`, `proxy-b.pem`, `proxy-b.key`, `cam-a.pem`, `cam-a.key`, `outside-a.pem`, `outside-a.key`, `selfsigned.pem`, `selfsigned.key`)
- Create: `server/tls/fingerprint.ts`
- Test: `test/fingerprint.test.ts` (new)

**Interfaces:**
- Produces:
  - `normalizeFingerprint(v: unknown): string | null` (64 lowercase hex or null)
  - `fingerprintList(v: unknown): string[] | null` (a string or a non-empty array of strings, each valid; null otherwise)
  - `formatFingerprint(hex: string): string` (`SHA256:AB:CD:…`)
  - `certFingerprint(pem: string | Buffer): string` (normalized SHA-256 of the DER)
  - Fixtures: site "test": CA A (`CN=cam-proxy site CA test`, name constraints `.test.internal` and `127.0.0.0/8`), CA B (same constraints, another key), `proxy-a` (A; `DNS:proxy.test.internal, IP:127.0.0.1`), `proxy-b` (B; same SANs), `cam-a` (A; `DNS:cam3.test.internal, IP:127.0.0.1`), `outside-a` (A; `DNS:evil.example, IP:127.0.0.1`, outside the constraints), `selfsigned` (`CN=CERTIFICATE`, self-signed like the camera's factory certificate). All RSA 2048, 20 years.

- [ ] **Step 1: Write the fixture script and run it**

```bash
#!/usr/bin/env bash
# test/fixtures/site-ca/make.sh: the test-only site CA fixtures (cam-proxy
# spec 2026-10-05 §10.1), committed. Never used outside tests. Run from the
# repo root: bash test/fixtures/site-ca/make.sh (OpenSSL 3).
set -euo pipefail
cd "$(dirname "$0")"
DAYS=7300
cnf() { printf '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=%s\n[ext]\n%s\n' "$1" "$2"; }
CA_EXT=$'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nnameConstraints=critical,permitted;DNS:.test.internal,permitted;IP:127.0.0.0/255.0.0.0'
ca() { # name
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days $DAYS -keyout "$1.key" -out "$1.pem" \
    -config <(cnf "cam-proxy site CA test" "$CA_EXT") -extensions ext
}
leaf() { # name ca cn san
  openssl req -new -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -config <(cnf "$3" "")
  openssl x509 -req -in "$1.csr" -CA "$2.pem" -CAkey "$2.key" -CAcreateserial -sha256 -days $DAYS -out "$1.pem" \
    -extfile <(printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$4")
  rm -f "$1.csr"
}
ca ca-a
ca ca-b
leaf proxy-a ca-a proxy.test.internal 'DNS:proxy.test.internal,IP:127.0.0.1'
leaf proxy-b ca-b proxy.test.internal 'DNS:proxy.test.internal,IP:127.0.0.1'
leaf cam-a ca-a cam3.test.internal 'DNS:cam3.test.internal,IP:127.0.0.1'
leaf outside-a ca-a evil.example 'DNS:evil.example,IP:127.0.0.1'
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days $DAYS -keyout selfsigned.key -out selfsigned.pem -config <(cnf CERTIFICATE "")
rm -f ./*.srl
```

Run: `bash test/fixtures/site-ca/make.sh && ls test/fixtures/site-ca`
Expected: the 14 `.pem`/`.key` files plus `make.sh`.

Run: `openssl verify -CAfile test/fixtures/site-ca/ca-a.pem test/fixtures/site-ca/proxy-a.pem test/fixtures/site-ca/outside-a.pem`
Expected: `proxy-a.pem: OK` and an error for `outside-a.pem` mentioning "permitted subtree violation".

- [ ] **Step 2: Write the failing test**

```ts
// test/fingerprint.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { X509Certificate } from 'crypto';
import { join } from 'path';
import { certFingerprint, fingerprintList, formatFingerprint, normalizeFingerprint } from '../server/tls/fingerprint';

const pem = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', `${n}.pem`), 'utf8');
const HEX = 'ab'.repeat(32);

describe('fingerprints', () => {
  it('normalizes the forms people paste', () => {
    for (const v of [HEX, HEX.toUpperCase(), `SHA256:${HEX}`, `sha256:${HEX.match(/../g)!.join(':')}`, ` SHA-256:${HEX.toUpperCase()} `]) expect(normalizeFingerprint(v)).toBe(HEX);
  });

  it('refuses anything else', () => {
    for (const v of [undefined, 42, '', 'SHA256:abc', HEX.slice(2), `${HEX}00`, 'q'.repeat(64), 'SHA256:q83vEjRWeJA='] as unknown[]) expect(normalizeFingerprint(v)).toBeNull();
  });

  it('takes one or a list (CA rotation, spec §10.7)', () => {
    expect(fingerprintList(HEX)).toEqual([HEX]);
    expect(fingerprintList([HEX, `SHA256:${'cd'.repeat(32)}`])).toEqual([HEX, 'cd'.repeat(32)]);
    expect(fingerprintList([])).toBeNull();
    expect(fingerprintList([HEX, 'nope'])).toBeNull();
  });

  it('formats like the proxy’s Certificates card and computes it from a PEM', () => {
    expect(formatFingerprint(HEX)).toBe(`SHA256:${'AB:'.repeat(31)}AB`);
    const ca = pem('ca-a');
    expect(certFingerprint(ca)).toBe(normalizeFingerprint(new X509Certificate(ca).fingerprint256));
    expect(certFingerprint(ca)).not.toBe(certFingerprint(pem('ca-b')));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/fingerprint.test.ts`
Expected: FAIL: `Cannot find module '../server/tls/fingerprint'`.

- [ ] **Step 4: Implement**

```ts
// server/tls/fingerprint.ts
import { X509Certificate } from 'crypto';

// A SHA-256 certificate fingerprint as cams compares it: 64 lowercase hex
// digits. Accepted as typed: "SHA256:" (or "SHA-256:") and hex, with or
// without colons, any case (Node gives "AB:CD:…"; cam-proxy's Certificates
// card shows "SHA256:AB:CD:…"). Anything else (base64 included) is null.
export function normalizeFingerprint(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().replace(/^sha-?256:/i, '').replace(/:/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

// One fingerprint or a non-empty list (a CA rotation, spec 2026-10-05 §10.7).
export function fingerprintList(v: unknown): string[] | null {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) return null;
  const out = list.map(normalizeFingerprint);
  return out.every((f): f is string => f !== null) ? out : null;
}

export const formatFingerprint = (hex: string): string => `SHA256:${hex.toUpperCase().match(/../g)!.join(':')}`;

export const certFingerprint = (pem: string | Buffer): string => normalizeFingerprint(new X509Certificate(pem).fingerprint256)!;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/fingerprint.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/site-ca server/tls/fingerprint.ts test/fingerprint.test.ts
git commit -m "test: site CA fixtures; fingerprint helpers"
```

---

### Task 6: Fetch a proxy's site CA against its pin; the fake proxy over HTTPS

**Files:**
- Create: `server/tls/siteCa.ts`
- Modify: `package.json` (`"undici": "^8.11.2"` in `dependencies`), `package-lock.json` (`npm install undici@^8.11.2`)
- Modify: `test/proxy/fakeProxy.ts` (`startFakeProxy({ tls })`, `caPem`, `cameraTls`, `GET /tls/ca.pem`)
- Test: `test/siteCa.test.ts` (new)

**Interfaces:**
- Consumes: `normalizeFingerprint`, `formatFingerprint` (Task 5).
- Produces:
  - `class SiteCaError extends Error { code: 'ca_unreachable' | 'ca_invalid' | 'ca_pin_mismatch' }`
  - `fetchPinnedCa(url: string, pins: string[], o?: { timeoutMs?: number }): Promise<{ pem: string; fingerprint: string }>`
  - `siteCaDispatcher(pems: string[], servername?: string): Dispatcher` (undici `Agent` trusting only these CAs)
  - `fetchWith(dispatcher: Dispatcher | undefined): typeof fetch` (global fetch without one, undici's fetch with it)
  - fake proxy: `startFakeProxy({ tls?: { key: Buffer | string; cert: Buffer | string } })` → `https://127.0.0.1:<port>`; `fake.caPem: string | null` (served at `GET /tls/ca.pem`, no token; null → 404); `fake.cameraTls: Map<string, unknown>` (proxy id → the `tls` block of `/api/cameras`, cam-proxy spec §10.4; absent → no `tls` field)

- [ ] **Step 1: Write the failing test**

```ts
// test/siteCa.test.ts
// The site CA (cam-proxy spec 2026-10-05 §10.1.4): cams fetches
// /tls/ca.pem, accepts it only if its fingerprint is pinned, and then trusts
// only that CA for the proxy, checked against the proxy's TLS name.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { certFingerprint } from '../server/tls/fingerprint';
import { fetchPinnedCa, fetchWith, siteCaDispatcher, SiteCaError } from '../server/tls/siteCa';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const read = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const CA_A = read('ca-a.pem'), CA_B = read('ca-b.pem');
const A = certFingerprint(CA_A), B = certFingerprint(CA_B);
let fake: FakeProxy | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});
async function httpsProxy(leaf = 'proxy-a', ca: string | null = CA_A): Promise<FakeProxy> {
  fake = await startFakeProxy({ tls: { key: read(`${leaf}.key`), cert: read(`${leaf}.pem`) } });
  fake.caPem = ca;
  return fake;
}
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof SiteCaError ? e.code : `other: ${(e as Error).message}`));

describe('fetchPinnedCa', () => {
  it('accepts the CA whose fingerprint is pinned', async () => {
    const f = await httpsProxy();
    expect(f.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const got = await fetchPinnedCa(f.url, [A]);
    expect(got.fingerprint).toBe(A);
    expect(certFingerprint(got.pem)).toBe(A);
  });

  it('accepts it from a rotation list', async () => {
    expect((await fetchPinnedCa((await httpsProxy()).url, [B, A])).fingerprint).toBe(A);
  });

  it('refuses another CA (a wrong pin)', async () => {
    expect(await code(fetchPinnedCa((await httpsProxy()).url, [B]))).toBe('ca_pin_mismatch');
  });

  it('refuses a pinned certificate that isn’t a CA', async () => {
    const f = await httpsProxy('proxy-a', read('proxy-a.pem'));
    expect(await code(fetchPinnedCa(f.url, [certFingerprint(read('proxy-a.pem'))]))).toBe('ca_invalid');
  });

  it('says unreachable for a 404 and for a dead proxy', async () => {
    const f = await httpsProxy('proxy-a', null);
    expect(await code(fetchPinnedCa(f.url, [A]))).toBe('ca_unreachable');
    expect(await code(fetchPinnedCa('https://127.0.0.1:9', [A], { timeoutMs: 1000 }))).toBe('ca_unreachable');
  });

  it('works over plain http too (cams on the proxy’s own host)', async () => {
    fake = await startFakeProxy();
    fake.caPem = CA_A;
    expect((await fetchPinnedCa(fake.url, [A])).fingerprint).toBe(A);
  });
});

describe('siteCaDispatcher', () => {
  const health = (url: string, pems: string[], servername?: string) =>
    fetchWith(siteCaDispatcher(pems, servername))(`${url}/api/cameras`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }).then((r) => r.status, (e: unknown) => `refused: ${(e as Error).name}`);

  it('trusts the proxy’s leaf by the CA and the proxy’s TLS name', async () => {
    expect(await health((await httpsProxy()).url, [CA_A], 'proxy.test.internal')).toBe(200);
  });

  it('refuses another CA, another name, and a leaf outside the name constraints', async () => {
    const f = await httpsProxy();
    expect(await health(f.url, [CA_B], 'proxy.test.internal')).toMatch(/^refused/);
    expect(await health(f.url, [CA_A], 'cam3.test.internal')).toMatch(/^refused/);
    await f.stop();
    const evil = await httpsProxy('outside-a');
    expect(await health(evil.url, [CA_A], 'evil.example')).toMatch(/^refused/);
  });

  it('never falls back to the public CAs', async () => {
    expect(await health((await httpsProxy()).url, [CA_B])).toMatch(/^refused/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/siteCa.test.ts`
Expected: FAIL: `Cannot find module '../server/tls/siteCa'`.

- [ ] **Step 3: Add undici and write `siteCa.ts`**

Run: `npm install undici@^8.11.2`
Expected: `package.json` lists `"undici": "^8.11.2"` under `dependencies`; the lockfile's `node_modules/undici` stays 8.11.x.

```ts
// server/tls/siteCa.ts
import { X509Certificate } from 'crypto';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { formatFingerprint, normalizeFingerprint } from './fingerprint';

// A cam-proxy's site CA (cam-proxy spec 2026-10-05 §10.1.4): cams pins its
// SHA-256 fingerprint, fetches the certificate from GET /tls/ca.pem (public,
// no token) and accepts it only when the fingerprint matches. The PEM itself
// is what is checked, so it is fetched without verifying the proxy's own
// certificate (which that CA signed). Errors name the proxy's host only.

export type SiteCaErrorCode = 'ca_unreachable' | 'ca_invalid' | 'ca_pin_mismatch';
export class SiteCaError extends Error {
  constructor(readonly code: SiteCaErrorCode, message: string) {
    super(message);
    this.name = 'SiteCaError';
  }
}

const MAX_PEM = 65_536;

export async function fetchPinnedCa(url: string, pins: string[], o: { timeoutMs?: number } = {}): Promise<{ pem: string; fingerprint: string }> {
  const base = new URL(url);
  const target = new URL(`${base.pathname.replace(/\/+$/, '')}/tls/ca.pem`, base);
  const dispatcher = base.protocol === 'https:' ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  let text: string;
  try {
    const res = await undiciFetch(target, { dispatcher, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    if (!res.ok) {
      await res.body?.cancel();
      throw new SiteCaError('ca_unreachable', `cam-proxy ${base.host} answered ${res.status} for /tls/ca.pem`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PEM) throw new SiteCaError('ca_invalid', `cam-proxy ${base.host}: /tls/ca.pem is too large`);
    text = buf.toString('utf8');
  } catch (err) {
    if (err instanceof SiteCaError) throw err;
    throw new SiteCaError('ca_unreachable', `cam-proxy ${base.host}: /tls/ca.pem unreachable (${(err as Error).name})`);
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
  const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)?.[0];
  if (!block) throw new SiteCaError('ca_invalid', `cam-proxy ${base.host}: /tls/ca.pem holds no certificate`);
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(block);
  } catch {
    throw new SiteCaError('ca_invalid', `cam-proxy ${base.host}: /tls/ca.pem is not a certificate`);
  }
  const fingerprint = normalizeFingerprint(cert.fingerprint256)!;
  if (!pins.includes(fingerprint)) throw new SiteCaError('ca_pin_mismatch', `cam-proxy ${base.host}: its site CA ${formatFingerprint(fingerprint)} is not the pinned one`);
  if (!cert.ca) throw new SiteCaError('ca_invalid', `cam-proxy ${base.host}: /tls/ca.pem is not a CA certificate`);
  return { pem: `${block}\n`, fingerprint };
}

// Trusts only these CAs (never the public ones); the proxy is reached by
// address and its certificate checked against `servername`
// (proxy.<site>.internal, spec §10.3), or the URL's host without one.
export function siteCaDispatcher(pems: string[], servername?: string): Dispatcher {
  return new Agent({ connect: { ca: pems, rejectUnauthorized: true, ...(servername && { servername }) } });
}

// fetch through a dispatcher (undici's own fetch, so the two always match),
// or the global fetch without one.
export function fetchWith(dispatcher: Dispatcher | undefined): typeof fetch {
  if (!dispatcher) return fetch;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher })) as unknown as typeof fetch;
}
```

- [ ] **Step 4: The fake proxy over HTTPS, with `/tls/ca.pem` and a `tls` block**

In `test/proxy/fakeProxy.ts`:
- `import https from 'https';`
- interface `FakeProxy` gains

```ts
  caPem: string | null; // GET /tls/ca.pem (public, no token; null: 404), like a site-CA cam-proxy (spec 2026-10-05 §10.4)
  cameraTls: Map<string, unknown>; // proxy camera id → its `tls` block in /api/cameras (absent: no field, like a proxy without a site CA)
```

- `startFakeProxy(opts: { port?: number; token?: string; tls?: { key: Buffer | string; cert: Buffer | string } } = {})`; initial values `caPem: null, cameraTls: new Map(),`
- in the auth middleware, `if (req.path === '/health') return next();` becomes `if (req.path === '/health' || req.path === '/tls/ca.pem') return next();`
- next to `/health`:

```ts
  app.get('/tls/ca.pem', (_req, res) => {
    if (!fake.caPem) return void res.status(404).json({ error: 'not_found' });
    res.type('application/x-pem-file').send(fake.caPem);
  });
```

- in `GET /api/cameras`'s mapper add `...(fake.cameraTls.has(id) && { tls: fake.cameraTls.get(id) }), error: null` to each entry
- the server: `const server = opts.tls ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, app) : http.createServer(app);` and `fake.url = \`${opts.tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}\`;`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/siteCa.test.ts test/fakeProxyMulti.test.ts test/proxyStream.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/tls/siteCa.ts test/proxy/fakeProxy.ts test/siteCa.test.ts
git commit -m "feat: fetch a cam-proxy's site CA against its pinned fingerprint"
```

---

### Task 7: Generator input and secrets

**Files:**
- Create: `server/cameraImport.ts` (first part)
- Test: `test/cameraImport.test.ts` (new; first `describe`)

**Interfaces:**
- Consumes: `fingerprintList` (Task 5), `validCameraAddress` (registry).
- Produces:
  - `type Secret = string | { env: string } | { file: string }`
  - `class ImportError extends Error`
  - `interface ImportCamera { id?: string; name?: string; user?: string; password?: string; protocol?: 'https' | 'http'; tlsServername?: string; host?: string; webUiUrl?: string | null; webUiNote?: string }` (resolved)
  - `interface ImportProxy { url: string; tlsServername?: string; caFingerprint?: string[]; token: string; adminToken?: string; cameraUser: string; cameraPassword: string; prefix: string; protocol?: 'https' | 'http'; cameras: Record<string, ImportCamera> }` (resolved; `url` without trailing slashes)
  - `parseImportInput(text: string, baseDir: string, env: NodeJS.ProcessEnv): ImportProxy[]` (throws `ImportError` naming the JSON path, e.g. `proxies[1].token`, never a value)

- [ ] **Step 1: Write the failing test**

```ts
// test/cameraImport.test.ts
// The cameras.json generator's logic (cam-proxy spec 2026-10-05 §13.3;
// scripts/cameras-config.ts is its command line).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImportError, parseImportInput } from '../server/cameraImport';

const T = 't'.repeat(40), PW = 'camera-password-1';
const HEX = 'ab'.repeat(32);
const dir = mkdtempSync(join(tmpdir(), 'cams-import-'));
const parse = (input: unknown, env: NodeJS.ProcessEnv = {}) => parseImportInput(JSON.stringify(input), dir, env);
const errorOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError);
    return (e as Error).message;
  }
  throw new Error('no error');
};

describe('generator input', () => {
  it('resolves secrets from the file, the environment and files', () => {
    writeFileSync(join(dir, 'token.txt'), `${T}\n`);
    const [p] = parse(
      { proxies: [{ url: 'https://192.168.1.230:8443/', tlsServername: 'proxy.garage.internal', caFingerprint: `SHA256:${HEX}`, token: { file: 'token.txt' }, adminToken: { env: 'ADMIN' }, cameraUser: 'cams', cameraPassword: PW, prefix: 'garage-', cameras: { cam4: { id: 'gate', password: { env: 'GATE_PW' } } } }] },
      { ADMIN: 'a'.repeat(40), GATE_PW: 'gate-pw' },
    );
    expect(p).toEqual({ url: 'https://192.168.1.230:8443', tlsServername: 'proxy.garage.internal', caFingerprint: [HEX], token: T, adminToken: 'a'.repeat(40), cameraUser: 'cams', cameraPassword: PW, prefix: 'garage-', cameras: { cam4: { id: 'gate', password: 'gate-pw' } } });
  });

  it('defaults the prefix to none and the cameras to {}', () => {
    expect(parse({ proxies: [{ url: 'http://127.0.0.1:8480', token: T, cameraUser: 'cams', cameraPassword: PW }] })[0]).toMatchObject({ prefix: '', cameras: {} });
  });

  it('names the field, never the value', () => {
    const msg = errorOf(() => parse({ proxies: [{ url: 'http://a', token: { env: 'NOPE' }, cameraUser: 'cams', cameraPassword: 'secret-pw-value' }] }));
    expect(msg).toBe('proxies[0].token: environment variable NOPE is not set');
    expect(errorOf(() => parse({ proxies: [{ url: 'http://a', token: { file: 'missing.txt' }, cameraUser: 'c', cameraPassword: PW }] }))).toBe('proxies[0].token: file missing.txt is not readable');
    const short = errorOf(() => parse({ proxies: [{ url: 'http://a', token: 'short-token-value', cameraUser: 'c', cameraPassword: PW }] }));
    expect(short).toBe('proxies[0].token: must be 32 or more characters without spaces');
    expect(short).not.toContain('short-token-value');
  });

  it('checks the shape', () => {
    expect(errorOf(() => parse([]))).toBe('input: must be {"proxies": [ … ]} with at least one proxy');
    expect(errorOf(() => parse({ proxies: [{ url: 'ftp://a', token: T, cameraUser: 'c', cameraPassword: PW }] }))).toBe('proxies[0].url: must be an http(s) URL without credentials, query or hash');
    expect(errorOf(() => parse({ proxies: [{ url: 'http://a', token: T, cameraUser: 'c', cameraPassword: PW, caFingerprint: 'abc' }] }))).toBe('proxies[0].caFingerprint: must be a SHA-256 fingerprint (64 hex digits, "SHA256:" optional) or a list of them');
    expect(errorOf(() => parse({ proxies: [{ url: 'http://a', token: T, cameraUser: 'c', cameraPassword: PW, cameras: { 'Bad Id': {} } }] }))).toBe('proxies[0].cameras: "Bad Id" is not a camera id');
    expect(errorOf(() => parse({ proxies: [{ url: 'http://a', token: T, cameraUser: 'c', cameraPassword: PW, cameras: { cam1: { id: 'UPPER' } } }] }))).toBe('proxies[0].cameras.cam1.id: must match /^[a-z0-9][a-z0-9-]{0,31}$/');
    expect(errorOf(() => parse({ proxies: [{ url: 'http://a', token: T, cameraUser: 'c', cameraPassword: PW, prefix: 'Garage ' }] }))).toBe('proxies[0].prefix: lowercase letters, digits and dashes, up to 16 characters');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cameraImport.test.ts`
Expected: FAIL: `Cannot find module '../server/cameraImport'`.

- [ ] **Step 3: Implement the input part**

```ts
// server/cameraImport.ts
// The cameras.json generator (cam-proxy spec 2026-10-05 §13.3): from a short
// list of cam-proxies, one cams camera per camera each proxy serves. A
// library, so a later "Add proxy" in cams can use it (§13.4);
// scripts/cameras-config.ts is its command line. It never prints a secret:
// errors name a field, diffs show •••.
import { readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { fingerprintList } from './tls/fingerprint';

export type Secret = string | { env: string } | { file: string };

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportCamera { id?: string; name?: string; user?: string; password?: string; protocol?: 'https' | 'http'; tlsServername?: string; host?: string; webUiUrl?: string | null; webUiNote?: string }
export interface ImportProxy {
  url: string;
  tlsServername?: string;
  caFingerprint?: string[];
  token: string;
  adminToken?: string;
  cameraUser: string;
  cameraPassword: string;
  prefix: string;
  protocol?: 'https' | 'http';
  cameras: Record<string, ImportCamera>;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const fail = (path: string, what: string): never => {
  throw new ImportError(`${path}: ${what}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, path: string, optional = false): string | undefined => {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !v.length) fail(path, 'must be a non-empty string');
  return v as string;
};

function secret(v: unknown, path: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  let value: string | undefined;
  if (typeof v === 'string') value = v;
  else if (isObj(v) && typeof v.env === 'string' && Object.keys(v).length === 1) {
    value = env[v.env];
    if (value === undefined || value === '') fail(path, `environment variable ${v.env} is not set`);
  } else if (isObj(v) && typeof v.file === 'string' && Object.keys(v).length === 1) {
    try {
      value = readFileSync(isAbsolute(v.file) ? v.file : join(baseDir, v.file), 'utf8').replace(/\r?\n$/, '');
    } catch {
      fail(path, `file ${v.file} is not readable`);
    }
  } else fail(path, 'must be a string, {"env": "NAME"} or {"file": "path"}');
  if (!value) fail(path, 'is empty');
  return value!;
}

const token = (v: unknown, path: string, baseDir: string, env: NodeJS.ProcessEnv): string => {
  const t = secret(v, path, baseDir, env);
  if (t.length < 32 || /\s/.test(t)) fail(path, 'must be 32 or more characters without spaces');
  return t;
};

function proxyUrl(v: unknown, path: string): string {
  let u: URL | undefined;
  try {
    u = new URL(String(v));
  } catch {
    u = undefined;
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) fail(path, 'must be an http(s) URL without credentials, query or hash');
  return String(v).replace(/\/+$/, '');
}

const protocolOf = (v: unknown, path: string): 'https' | 'http' | undefined => {
  if (v === undefined) return undefined;
  if (v !== 'https' && v !== 'http') fail(path, 'must be "https" or "http"');
  return v as 'https' | 'http';
};

function cameraOf(v: unknown, path: string, baseDir: string, env: NodeJS.ProcessEnv): ImportCamera {
  if (!isObj(v)) fail(path, 'must be an object');
  const c = v as Record<string, unknown>;
  const out: ImportCamera = {};
  if (c.id !== undefined) {
    if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) fail(`${path}.id`, `must match ${ID_PATTERN}`);
    out.id = c.id as string;
  }
  for (const k of ['name', 'user', 'tlsServername', 'host', 'webUiNote'] as const) if (c[k] !== undefined) out[k] = text(c[k], `${path}.${k}`);
  if (c.password !== undefined) out.password = secret(c.password, `${path}.password`, baseDir, env);
  if (c.protocol !== undefined) out.protocol = protocolOf(c.protocol, `${path}.protocol`);
  if (c.webUiUrl !== undefined) {
    if (c.webUiUrl !== null && !(typeof c.webUiUrl === 'string' && /^https?:\/\/[^\s]+$/.test(c.webUiUrl))) fail(`${path}.webUiUrl`, 'must be an http(s) URL or null');
    out.webUiUrl = c.webUiUrl as string | null;
  }
  return out;
}

export function parseImportInput(input: string, baseDir: string, env: NodeJS.ProcessEnv): ImportProxy[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('input', 'is not valid JSON');
  }
  if (!isObj(parsed) || !Array.isArray(parsed.proxies) || !parsed.proxies.length) fail('input', 'must be {"proxies": [ … ]} with at least one proxy');
  return ((parsed as { proxies: unknown[] }).proxies).map((raw, i) => {
    const at = `proxies[${i}]`;
    if (!isObj(raw)) fail(at, 'must be an object');
    const p = raw as Record<string, unknown>;
    const out: ImportProxy = {
      url: proxyUrl(p.url, `${at}.url`),
      token: token(p.token, `${at}.token`, baseDir, env),
      cameraUser: text(p.cameraUser, `${at}.cameraUser`)!,
      cameraPassword: secret(p.cameraPassword, `${at}.cameraPassword`, baseDir, env),
      prefix: '',
      cameras: {},
    };
    if (p.tlsServername !== undefined) out.tlsServername = text(p.tlsServername, `${at}.tlsServername`);
    if (p.caFingerprint !== undefined) {
      const pins = fingerprintList(p.caFingerprint);
      if (!pins) fail(`${at}.caFingerprint`, 'must be a SHA-256 fingerprint (64 hex digits, "SHA256:" optional) or a list of them');
      out.caFingerprint = pins!;
    }
    if (p.adminToken !== undefined) out.adminToken = token(p.adminToken, `${at}.adminToken`, baseDir, env);
    if (p.prefix !== undefined) {
      if (typeof p.prefix !== 'string' || !/^[a-z0-9-]{0,16}$/.test(p.prefix)) fail(`${at}.prefix`, 'lowercase letters, digits and dashes, up to 16 characters');
      out.prefix = p.prefix as string;
    }
    if (p.protocol !== undefined) out.protocol = protocolOf(p.protocol, `${at}.protocol`);
    if (p.cameras !== undefined) {
      if (!isObj(p.cameras)) fail(`${at}.cameras`, 'must be an object keyed by the proxy’s camera ids');
      for (const [id, c] of Object.entries(p.cameras as Record<string, unknown>)) {
        if (!ID_PATTERN.test(id)) fail(`${at}.cameras`, `"${id}" is not a camera id`);
        out.cameras[id] = cameraOf(c, `${at}.cameras.${id}`, baseDir, env);
      }
    }
    return out;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cameraImport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cameraImport.ts test/cameraImport.test.ts
git commit -m "feat: cameras.json generator input with secrets from env and files"
```

---

### Task 8: Generator: read each proxy's cameras (with and without a pin)

**Files:**
- Modify: `server/cameraImport.ts` (append)
- Test: `test/cameraImport.test.ts` (second `describe`)

**Interfaces:**
- Consumes: `ImportProxy` (Task 7), `fetchPinnedCa`, `siteCaDispatcher`, `fetchWith` (Task 6), `validCameraAddress`.
- Produces:
  - `interface ProxyCamera { id: string; name: string | null; address: string | null; tls: { mode: string; servername: string | null; fingerprint: string | null } | null }`
  - `readProxyCameras(p: ImportProxy, o?: { timeoutMs?: number }): Promise<ProxyCamera[]>` (with `caFingerprint`: CA fetched and checked first, then `GET /api/cameras` trusting only it; errors as `ImportError` `proxy <host>: …`)

- [ ] **Step 1: Write the failing test** (append to `test/cameraImport.test.ts`; add `readProxyCameras` and `type ImportProxy` to the import from `../server/cameraImport`, `readFileSync` to the `fs` import, plus:)

```ts
import { certFingerprint } from '../server/tls/fingerprint';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const fakes: FakeProxy[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
});
async function fakeProxy(tls = false): Promise<FakeProxy> {
  const f = await startFakeProxy(tls ? { tls: { key: fx('proxy-a.key'), cert: fx('proxy-a.pem') } } : {});
  if (tls) f.caPem = fx('ca-a.pem');
  fakes.push(f);
  return f;
}
const proxyIn = (f: FakeProxy, more: Partial<ImportProxy> = {}): ImportProxy => ({ url: f.url, token: FAKE_TOKEN, cameraUser: 'cams', cameraPassword: PW, prefix: '', cameras: {}, ...more });

describe('reading a proxy', () => {
  it('lists the cameras of a proxy without a site CA', async () => {
    const f = await fakeProxy();
    f.cameraNames.set('cam3', 'Gate');
    f.cameraAddresses.set('cam3', '192.168.60.13');
    expect(await readProxyCameras(proxyIn(f))).toEqual([
      { id: 'cam1', name: 'Den', address: '192.0.2.10', tls: null },
      { id: 'cam3', name: 'Gate', address: '192.168.60.13', tls: null },
    ]);
  });

  it('checks the pin, then reads over TLS trusting only that CA', async () => {
    const f = await fakeProxy(true);
    f.cameraTls.set('cam1', { mode: 'site-ca', servername: 'cam3.test.internal', fingerprint: 'ab'.repeat(32), notAfter: 0, lastPush: null });
    const [c] = await readProxyCameras(proxyIn(f, { tlsServername: 'proxy.test.internal', caFingerprint: [certFingerprint(fx('ca-a.pem'))] }));
    expect(c.tls).toEqual({ mode: 'site-ca', servername: 'cam3.test.internal', fingerprint: 'ab'.repeat(32) });
    expect(f.requests.map((r) => r.path)).toEqual(['/tls/ca.pem', '/api/cameras']);
  });

  it('stops on a wrong pin before sending the token', async () => {
    const f = await fakeProxy(true);
    await expect(readProxyCameras(proxyIn(f, { tlsServername: 'proxy.test.internal', caFingerprint: [certFingerprint(fx('ca-b.pem'))] }))).rejects.toThrow(/^proxy 127\.0\.0\.1:\d+: its site CA SHA256:.* is not the pinned one$/);
    expect(f.requests.map((r) => r.path)).toEqual(['/tls/ca.pem']);
  });

  it('stops on an unreachable proxy and on a refused token', async () => {
    await expect(readProxyCameras({ ...proxyIn(await fakeProxy()), url: 'http://127.0.0.1:9' }, { timeoutMs: 1000 })).rejects.toThrow(/^proxy 127\.0\.0\.1:9: unreachable/);
    await expect(readProxyCameras({ ...proxyIn(await fakeProxy()), token: 'x'.repeat(40) })).rejects.toThrow(/^proxy 127\.0\.0\.1:\d+: refused the token \(401\)$/);
  });

  it('ignores entries that aren’t cameras', async () => {
    const f = await fakeProxy();
    f.camerasBody = [{ id: 'cam1', name: 'Den' }, { id: 'Bad Id' }, null, { name: 'no id' }];
    expect((await readProxyCameras(proxyIn(f))).map((c) => c.id)).toEqual(['cam1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cameraImport.test.ts -t "reading a proxy"`
Expected: FAIL: `readProxyCameras is not a function` (or not exported).

- [ ] **Step 3: Implement** (append to `server/cameraImport.ts`; add imports `import type { Dispatcher } from 'undici';`, `import { validCameraAddress } from './cameraRegistry';` and `import { fetchPinnedCa, fetchWith, siteCaDispatcher, SiteCaError } from './tls/siteCa';`)

```ts
export interface ProxyCamera {
  id: string; // the proxy's id
  name: string | null;
  address: string | null;
  tls: { mode: string; servername: string | null; fingerprint: string | null } | null; // spec §10.4; null: the proxy has no site CA
}

const shortText = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 64 && !/\p{C}/u.test(v) ? v : null);

function tlsOf(v: unknown): ProxyCamera['tls'] {
  if (!isObj(v) || typeof v.mode !== 'string') return null;
  return { mode: v.mode.slice(0, 16), servername: typeof v.servername === 'string' && /^[a-z0-9.-]{1,253}$/i.test(v.servername) ? v.servername : null, fingerprint: typeof v.fingerprint === 'string' ? v.fingerprint : null };
}

// The cameras a proxy serves (GET /api/cameras with its client token). With
// a pinned site CA: /tls/ca.pem first, checked against the pin, then the
// list over TLS that trusts only that CA (spec §13.3). The token is sent
// only after the pin matched.
export async function readProxyCameras(p: ImportProxy, o: { timeoutMs?: number } = {}): Promise<ProxyCamera[]> {
  const host = new URL(p.url).host;
  const timeoutMs = o.timeoutMs ?? 10_000;
  let dispatcher: Dispatcher | undefined;
  if (p.caFingerprint) {
    try {
      const ca = await fetchPinnedCa(p.url, p.caFingerprint, { timeoutMs });
      dispatcher = siteCaDispatcher([ca.pem], p.tlsServername);
    } catch (err) {
      throw new ImportError(err instanceof SiteCaError ? `proxy ${host}: ${err.message.replace(/^cam-proxy [^:]+: /, '')}` : `proxy ${host}: ${(err as Error).name}`);
    }
  }
  let res: Response;
  try {
    res = await fetchWith(dispatcher)(`${p.url}/api/cameras`, { headers: { Authorization: `Bearer ${p.token}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ImportError(`proxy ${host}: unreachable (${(err as Error).name})`);
  }
  if (res.status === 401 || res.status === 403) throw new ImportError(`proxy ${host}: refused the token (${res.status})`);
  if (!res.ok) throw new ImportError(`proxy ${host}: answered ${res.status}`);
  let list: unknown;
  try {
    list = await res.json();
  } catch {
    throw new ImportError(`proxy ${host}: its camera list isn't JSON`);
  }
  if (!Array.isArray(list)) throw new ImportError(`proxy ${host}: its camera list isn't a list`);
  return list
    .filter((c): c is Record<string, unknown> => isObj(c) && typeof c.id === 'string' && ID_PATTERN.test(c.id))
    .map((c) => ({ id: c.id as string, name: shortText(c.name), address: validCameraAddress(c.address) ? c.address : null, tls: tlsOf(c.tls) }));
}
```

A `SiteCaError` message starts `cam-proxy <host>: `, so the `replace` leaves `its site CA SHA256:… is not the pinned one` / `/tls/ca.pem unreachable (…)`, matching the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cameraImport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cameraImport.ts test/cameraImport.test.ts
git commit -m "feat: generator reads each cam-proxy's cameras, checking a pinned site CA"
```

---

### Task 9: Generator: build the entries (stable ids, collisions, prune) and the diff

**Files:**
- Modify: `server/cameraImport.ts` (append), `server/cameraRegistry.ts` (nothing new: uses `parseCameras` from Task 2)
- Test: `test/cameraImport.test.ts` (third `describe`)

**Interfaces:**
- Consumes: `ImportProxy`, `ProxyCamera`, `parseCameras` (Task 2), `FROM_PROXY`.
- Produces:
  - `type Entry = Record<string, unknown>` (one `cameras.json` entry)
  - `interface BuildResult { entries: Entry[]; notes: string[] }` (`notes`: human lines, no secrets: kept-but-unlisted, pruned, ids kept over input ids)
  - `buildCameras(existing: Entry[], read: { proxy: ImportProxy; cameras: ProxyCamera[] }[], o: { prune: boolean }): BuildResult` (throws `ImportError` on an id collision or a camera it can't place; the result is validated with `parseCameras`)
  - `diffCameras(before: Entry[], after: Entry[]): string[]` (lines `+ id`, `- id`, `~ id: field old → new`, secrets as `•••`)

Entry rules (spec §13.3 + rulings):
- matched existing entry (same normalized `proxy.url` and `proxy.camera ?? id`): keeps `id`, `name`, `webUiUrl`, `webUiNote` (input `webUiUrl`/`webUiNote` override);
- new: `id` = input `id` ?? `prefix + proxy id`; `name` = input `name` ?? the proxy's name ?? the id;
- site-CA proxy (`caFingerprint`): `host: "from-proxy"`, `protocol: "https"`, `tlsServername` = input ?? the camera's `tls.servername` (omitted when neither);
- proxy without a site CA: `protocol` = camera ?? proxy ?? `"https"`; `tlsServername` = camera input; `host` = camera input ?? (`https` with a `tlsServername` → `"from-proxy"`) ?? the reported address; none → error;
- `user`/`password` = camera ?? proxy `cameraUser`/`cameraPassword`;
- `proxy` = `{url, token, adminToken?, camera: <proxy id>, tlsServername?, caFingerprint? (one string, or the list)}`.

- [ ] **Step 1: Write the failing test** (append; add `buildCameras`, `diffCameras`, `type ProxyCamera` to the import)

```ts
describe('building cameras.json', () => {
  const A = 'http://192.168.1.220:8480', G = 'https://192.168.1.230:8443';
  const pi = (more: Partial<ImportProxy> = {}): ImportProxy => ({ url: A, token: T, adminToken: 'a'.repeat(40), cameraUser: 'cams', cameraPassword: PW, prefix: '', cameras: { cam1: { tlsServername: 'cam1.skylar.technology' } }, ...more });
  const garage = (more: Partial<ImportProxy> = {}): ImportProxy => ({ url: G, tlsServername: 'proxy.garage.internal', caFingerprint: [HEX], token: T, cameraUser: 'cams', cameraPassword: PW, prefix: 'garage-', cameras: {}, ...more });
  const siteCam = (id: string, name: string): ProxyCamera => ({ id, name, address: `192.168.60.${id.slice(3)}`, tls: { mode: 'site-ca', servername: `${id}.garage.internal`, fingerprint: null } });

  it('writes the Pi’s entry as deploy/pi/cameras.example.json has it', () => {
    const { entries } = buildCameras([], [{ proxy: pi(), cameras: [{ id: 'cam1', name: 'Den', address: '192.168.1.164', tls: null }] }], { prune: false });
    expect(entries).toEqual([{ id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'cams', password: PW, proxy: { url: A, token: T, adminToken: 'a'.repeat(40), camera: 'cam1' } }]);
  });

  it('writes one entry per camera of a site-CA proxy, sharing url, token and pin', () => {
    const { entries } = buildCameras([], [{ proxy: garage(), cameras: [siteCam('cam3', 'Driveway'), siteCam('cam4', 'Gate')] }], { prune: false });
    expect(entries.map((e) => e.id)).toEqual(['garage-cam3', 'garage-cam4']);
    expect(entries[1]).toEqual({ id: 'garage-cam4', name: 'Gate', host: 'from-proxy', protocol: 'https', tlsServername: 'cam4.garage.internal', user: 'cams', password: PW, proxy: { url: G, token: T, camera: 'cam4', tlsServername: 'proxy.garage.internal', caFingerprint: HEX } });
  });

  it('keeps an existing camera’s id, name and links (stable ids)', () => {
    const existing = [{ id: 'den', name: 'My Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'cams', password: 'old', webUiNote: 'note', proxy: { url: `${A}/`, token: T, camera: 'cam1' } }];
    const { entries, notes } = buildCameras(existing, [{ proxy: pi({ cameras: { cam1: { id: 'other', tlsServername: 'cam1.skylar.technology' } } }), cameras: [{ id: 'cam1', name: 'Den', address: null, tls: null }] }], { prune: false });
    expect(entries[0]).toMatchObject({ id: 'den', name: 'My Den', webUiNote: 'note', password: PW });
    expect(notes).toContain('den: kept its id (the input asks for "other"; rename by hand)');
  });

  it('keeps direct cameras and other proxies’ cameras in place', () => {
    const shed = { id: 'shed', name: 'Shed', host: '127.0.0.1:8096', protocol: 'http', user: 'e2e', password: 'x' };
    const cam2 = { id: 'cam2', name: 'Cam 2', host: 'cam2.cam-sim.svc.cluster.local', protocol: 'https', tlsServername: 'cam2.skylar.technology', user: 'cams', password: 'y', proxy: { url: 'http://cam-proxy.cam-proxy.svc.cluster.local:8480', token: T } };
    const { entries } = buildCameras([shed, cam2], [{ proxy: pi(), cameras: [{ id: 'cam1', name: 'Den', address: null, tls: null }] }], { prune: false });
    expect(entries.map((e) => e.id)).toEqual(['shed', 'cam2', 'cam1']);
    expect(entries[1]).toEqual(cam2);
  });

  it('stops on an id collision across proxies, naming both', () => {
    const other = garage({ url: 'https://192.168.1.231:8443', prefix: '' });
    expect(() => buildCameras([], [{ proxy: garage({ prefix: '' }), cameras: [siteCam('cam3', 'A')] }, { proxy: other, cameras: [siteCam('cam3', 'B')] }], { prune: false })).toThrow(
      'id "cam3" is used by proxy 192.168.1.230:8443 camera cam3 and proxy 192.168.1.231:8443 camera cam3: give one an "id" or a "prefix"',
    );
    expect(() => buildCameras([{ id: 'garage-cam3', name: 'x', host: '127.0.0.1:1', protocol: 'http', user: 'u', password: 'p' }], [{ proxy: garage(), cameras: [siteCam('cam3', 'A')] }], { prune: false })).toThrow(
      'id "garage-cam3" is used by an existing entry without this proxy and proxy 192.168.1.230:8443 camera cam3: give one an "id" or a "prefix"',
    );
  });

  it('keeps and reports a camera the proxy no longer lists; --prune drops it', () => {
    const gone = { id: 'garage-cam9', name: 'Gone', host: 'from-proxy', protocol: 'https', tlsServername: 'cam9.garage.internal', user: 'cams', password: PW, proxy: { url: G, token: T, camera: 'cam9', caFingerprint: HEX } };
    const read = [{ proxy: garage(), cameras: [siteCam('cam3', 'A')] }];
    const kept = buildCameras([gone], read, { prune: false });
    expect(kept.entries.map((e) => e.id)).toEqual(['garage-cam9', 'garage-cam3']);
    expect(kept.notes).toContain('garage-cam9: proxy 192.168.1.230:8443 no longer lists camera cam9 (kept; --prune drops it)');
    const pruned = buildCameras([gone], read, { prune: true });
    expect(pruned.entries.map((e) => e.id)).toEqual(['garage-cam3']);
    expect(pruned.notes).toContain('garage-cam9: dropped (proxy 192.168.1.230:8443 no longer lists camera cam9)');
  });

  it('stops when a camera has no address to use', () => {
    const noTls = pi({ cameras: {} });
    expect(() => buildCameras([], [{ proxy: noTls, cameras: [{ id: 'cam1', name: 'Den', address: null, tls: null }] }], { prune: false })).toThrow(
      'proxy 192.168.1.220:8480 camera cam1: no address (the proxy reports none): set "host", or "tlsServername" for "from-proxy"',
    );
  });

  it('never shows a secret in the diff', () => {
    const before = [{ id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'cams', password: 'old-pw-value', proxy: { url: A, token: 'o'.repeat(40), camera: 'cam1' } }];
    const after = [{ ...before[0], name: 'Den 2', password: PW, proxy: { ...before[0].proxy, token: T } }, { id: 'new', name: 'N', host: 'h', protocol: 'http', user: 'u', password: 'p-secret', proxy: { url: A, token: T } }];
    const lines = diffCameras(before, after);
    expect(lines).toEqual(['~ cam1: name "Den" → "Den 2"', '~ cam1: password ••• → •••', '~ cam1: proxy.token ••• → •••', '+ new: {"id":"new","name":"N","host":"h","protocol":"http","user":"u","password":"•••","proxy":{"url":"http://192.168.1.220:8480","token":"•••"}}']);
    expect(lines.join('\n')).not.toMatch(/old-pw-value|p-secret|tttt|oooo/);
    expect(diffCameras(after, before)).toContain('- new');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cameraImport.test.ts -t "building cameras.json"`
Expected: FAIL: `buildCameras is not a function`.

- [ ] **Step 3: Implement** (append; add `parseCameras, FROM_PROXY` to the `./cameraRegistry` import)

```ts
export type Entry = Record<string, unknown>;
export interface BuildResult { entries: Entry[]; notes: string[] }

const SECRETS = new Set(['password', 'token', 'adminToken']);
const urlKey = (u: unknown) => String(u).replace(/\/+$/, '');
const hostOf = (u: string) => new URL(u).host;
const remoteOf = (e: Entry): string | undefined => {
  const p = e.proxy as Entry | undefined;
  return p ? ((p.camera as string | undefined) ?? (e.id as string)) : undefined;
};

function entryFor(p: ImportProxy, c: ProxyCamera, old: Entry | undefined): Entry {
  const input = p.cameras[c.id] ?? {};
  const where = `proxy ${hostOf(p.url)} camera ${c.id}`;
  let host: string, protocol: 'https' | 'http', tlsServername: string | undefined;
  if (p.caFingerprint) {
    host = FROM_PROXY;
    protocol = 'https';
    tlsServername = input.tlsServername ?? c.tls?.servername ?? undefined;
  } else {
    protocol = input.protocol ?? p.protocol ?? 'https';
    tlsServername = input.tlsServername;
    const h = input.host ?? (protocol === 'https' && tlsServername ? FROM_PROXY : c.address);
    if (!h) throw new ImportError(`${where}: no address (the proxy reports none): set "host", or "tlsServername" for "from-proxy"`);
    host = h;
  }
  const webUiUrl = input.webUiUrl !== undefined ? input.webUiUrl : old?.webUiUrl;
  const webUiNote = input.webUiNote ?? old?.webUiNote;
  const pins = p.caFingerprint;
  return {
    id: (old?.id as string | undefined) ?? input.id ?? `${p.prefix}${c.id}`,
    name: (old?.name as string | undefined) ?? input.name ?? c.name ?? input.id ?? `${p.prefix}${c.id}`,
    host,
    protocol,
    ...(tlsServername && { tlsServername }),
    user: input.user ?? p.cameraUser,
    password: input.password ?? p.cameraPassword,
    ...(webUiUrl !== undefined && { webUiUrl }),
    ...(webUiNote !== undefined && { webUiNote }),
    proxy: {
      url: p.url,
      token: p.token,
      ...(p.adminToken && { adminToken: p.adminToken }),
      camera: c.id,
      ...(p.tlsServername && { tlsServername: p.tlsServername }),
      ...(pins && { caFingerprint: pins.length === 1 ? pins[0] : pins }),
    },
  };
}

export function buildCameras(existing: Entry[], read: { proxy: ImportProxy; cameras: ProxyCamera[] }[], o: { prune: boolean }): BuildResult {
  const notes: string[] = [];
  const out: (Entry | null)[] = existing.map((e) => e); // null: dropped
  const source = new Map<number, string>(); // out index → where it comes from (for collisions)
  existing.forEach((e, i) => source.set(i, e.proxy ? `existing entry for proxy ${hostOf(urlKey((e.proxy as Entry).url))} camera ${remoteOf(e)}` : 'an existing entry without this proxy'));
  for (const { proxy: p, cameras } of read) {
    const listed = new Set(cameras.map((c) => c.id));
    for (const c of cameras) {
      const i = existing.findIndex((e) => e.proxy && urlKey((e.proxy as Entry).url) === p.url && remoteOf(e) === c.id);
      const old = i >= 0 ? existing[i] : undefined;
      const entry = entryFor(p, c, old);
      const asked = p.cameras[c.id]?.id;
      if (old && asked && asked !== old.id) notes.push(`${old.id}: kept its id (the input asks for "${asked}"; rename by hand)`);
      if (i >= 0) out[i] = entry;
      else {
        out.push(entry);
        source.set(out.length - 1, `proxy ${hostOf(p.url)} camera ${c.id}`);
      }
      if (i >= 0) source.set(i, `proxy ${hostOf(p.url)} camera ${c.id}`);
    }
    existing.forEach((e, i) => {
      if (!e.proxy || urlKey((e.proxy as Entry).url) !== p.url || listed.has(remoteOf(e)!)) return;
      const why = `proxy ${hostOf(p.url)} no longer lists camera ${remoteOf(e)}`;
      if (o.prune) {
        out[i] = null;
        notes.push(`${e.id}: dropped (${why})`);
      } else notes.push(`${e.id}: ${why} (kept; --prune drops it)`);
    });
  }
  const entries: Entry[] = [];
  const seen = new Map<string, number>();
  out.forEach((e, i) => {
    if (!e) return;
    const first = seen.get(e.id as string);
    if (first !== undefined) throw new ImportError(`id "${e.id}" is used by ${source.get(first)} and ${source.get(i)}: give one an "id" or a "prefix"`);
    seen.set(e.id as string, i);
    entries.push(e);
  });
  try {
    parseCameras(entries, 'the generated cameras.json');
  } catch (err) {
    throw new ImportError(`the result would not load in cams: ${(err as Error).message}`);
  }
  return { entries, notes };
}

// Field by field, secrets as •••.
function flat(e: Entry, prefix = ''): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [k, v] of Object.entries(e)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [kk, vv] of flat(v as Entry, `${prefix}${k}.`)) m.set(kk, vv);
    else m.set(`${prefix}${k}`, v);
  }
  return m;
}
const shown = (path: string, v: unknown) => (v === undefined ? '(none)' : SECRETS.has(path.split('.').at(-1)!) ? '•••' : JSON.stringify(v));
const masked = (e: Entry): Entry => JSON.parse(JSON.stringify(e, (k, v) => (SECRETS.has(k) && typeof v === 'string' ? '•••' : v)));

export function diffCameras(before: Entry[], after: Entry[]): string[] {
  const lines: string[] = [];
  const old = new Map(before.map((e) => [e.id as string, e]));
  const now = new Set(after.map((e) => e.id as string));
  for (const e of after) {
    const b = old.get(e.id as string);
    if (!b) {
      lines.push(`+ ${e.id}: ${JSON.stringify(masked(e))}`);
      continue;
    }
    const fb = flat(b), fa = flat(e);
    for (const k of new Set([...fb.keys(), ...fa.keys()])) {
      if (JSON.stringify(fb.get(k)) !== JSON.stringify(fa.get(k))) lines.push(`~ ${e.id}: ${k} ${shown(k, fb.get(k))} → ${shown(k, fa.get(k))}`);
    }
  }
  for (const e of before) if (!now.has(e.id as string)) lines.push(`- ${e.id}`);
  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cameraImport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cameraImport.ts test/cameraImport.test.ts
git commit -m "feat: generator builds cameras.json with stable ids, collision checks and a masked diff"
```

---

### Task 10: The command line, `scripts/cameras-config.ts`

**Files:**
- Modify: `server/cameraImport.ts` (append `runCamerasConfig`)
- Create: `scripts/cameras-config.ts`
- Modify: `tsconfig.check.json` (`"include"` gains `"scripts/**/*.ts"`), `.gitignore` (`cameras-config.json`), `README.md` (§ Cameras: a "Generating cameras.json" paragraph)
- Test: `test/camerasConfigCli.test.ts` (new)

**Interfaces:**
- Consumes: `parseImportInput`, `readProxyCameras`, `buildCameras`, `diffCameras`.
- Produces: `runCamerasConfig(argv: string[], env: NodeJS.ProcessEnv, io: { out: (line: string) => void; err: (line: string) => void }, now?: () => Date): Promise<number>` (exit code: 0 done, 1 refused, 2 usage). Flags: `--output <file>` (default `cameras.json`), `--input <file>` (default `cameras-config.json` next to the output), `--write`, `--prune`.

- [ ] **Step 1: Write the failing test**

```ts
// test/camerasConfigCli.test.ts
// scripts/cameras-config.ts (cam-proxy spec 2026-10-05 §13.3): dry run by
// default, --write atomically with a backup, nothing written on any failure.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCamerasConfig } from '../server/cameraImport';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const PW = 'camera-password-1';
const fakes: FakeProxy[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
});

async function setup(proxies: (url: string) => object[], existing?: unknown[]) {
  const f = await startFakeProxy();
  fakes.push(f);
  f.cameraAddresses.set('cam1', '192.168.1.164');
  const dir = mkdtempSync(join(tmpdir(), 'cams-cli-'));
  writeFileSync(join(dir, 'cameras-config.json'), JSON.stringify({ proxies: proxies(f.url) }), { mode: 0o600 });
  if (existing) writeFileSync(join(dir, 'cameras.json'), JSON.stringify(existing), { mode: 0o600 });
  const lines: string[] = [];
  const run = (...args: string[]) => runCamerasConfig(['--output', join(dir, 'cameras.json'), ...args], { PROXY_TOKEN: FAKE_TOKEN }, { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) }, () => new Date(Date.UTC(2026, 9, 5, 12, 0, 0)));
  return { f, dir, lines, run };
}
const proxy = (url: string) => ({ url, token: { env: 'PROXY_TOKEN' }, cameraUser: 'cams', cameraPassword: PW, protocol: 'http' });

describe('cameras-config', () => {
  it('prints a diff and writes nothing by default', async () => {
    const s = await setup((url) => [proxy(url)]);
    expect(await s.run()).toBe(0);
    expect(s.lines.some((l) => l.startsWith('+ cam1: '))).toBe(true);
    expect(s.lines.at(-1)).toBe('Dry run: nothing written. Run again with --write to write ' + join(s.dir, 'cameras.json') + '.');
    expect(existsSync(join(s.dir, 'cameras.json'))).toBe(false);
    expect(s.lines.join('\n')).not.toContain(FAKE_TOKEN);
    expect(s.lines.join('\n')).not.toContain(PW);
  });

  it('--write writes mode 600 and keeps a backup of the old file', async () => {
    const s = await setup((url) => [proxy(url)], [{ id: 'shed', name: 'Shed', host: '127.0.0.1:1', protocol: 'http', user: 'u', password: 'p' }]);
    expect(await s.run('--write')).toBe(0);
    const out = join(s.dir, 'cameras.json');
    expect(JSON.parse(readFileSync(out, 'utf8')).map((e: { id: string }) => e.id)).toEqual(['shed', 'cam1']);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const bak = readdirSync(s.dir).filter((n) => n.startsWith('cameras.json.bak-'));
    expect(bak).toEqual(['cameras.json.bak-20261005-120000']);
    expect(statSync(join(s.dir, bak[0])).mode & 0o777).toBe(0o600);
  });

  it('writes nothing when a later proxy fails', async () => {
    const s = await setup((url) => [proxy(url), { ...proxy('http://127.0.0.1:9'), prefix: 'b-' }], [{ id: 'shed', name: 'Shed', host: '127.0.0.1:1', protocol: 'http', user: 'u', password: 'p' }]);
    const before = readFileSync(join(s.dir, 'cameras.json'), 'utf8');
    expect(await s.run('--write')).toBe(1);
    expect(s.lines.at(-1)).toMatch(/^ERR proxy 127\.0\.0\.1:9: unreachable/);
    expect(readFileSync(join(s.dir, 'cameras.json'), 'utf8')).toBe(before);
    expect(readdirSync(s.dir).filter((n) => n.includes('.bak-') || n.includes('.tmp'))).toEqual([]);
  });

  it('refuses an input file others can read', async () => {
    const s = await setup((url) => [proxy(url)]);
    chmodSync(join(s.dir, 'cameras-config.json'), 0o644);
    expect(await s.run()).toBe(1);
    expect(s.lines.at(-1)).toBe(`ERR ${join(s.dir, 'cameras-config.json')} is readable by others: chmod 600 it (it holds tokens and passwords)`);
  });

  it('refuses unknown flags and secrets on the command line', async () => {
    const s = await setup((url) => [proxy(url)]);
    expect(await s.run('--token', 'x')).toBe(2);
    expect(s.lines.at(-1)).toBe('ERR usage: cameras-config [--output cameras.json] [--input cameras-config.json] [--write] [--prune]');
  });

  it('runs as a script with npx tsx', async () => {
    const s = await setup((url) => [proxy(url)]);
    const out = execFileSync('npx', ['tsx', 'scripts/cameras-config.ts', '--output', join(s.dir, 'cameras.json')], { env: { ...process.env, PROXY_TOKEN: FAKE_TOKEN }, encoding: 'utf8' });
    expect(out).toContain('+ cam1: ');
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/camerasConfigCli.test.ts`
Expected: FAIL: `runCamerasConfig is not a function`.

- [ ] **Step 3: Implement `runCamerasConfig`** (append to `server/cameraImport.ts`; add `import { promises as fs } from 'fs';` and `dirname, resolve` to the `path` import)

```ts
const USAGE = 'usage: cameras-config [--output cameras.json] [--input cameras-config.json] [--write] [--prune]';
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// The command line (scripts/cameras-config.ts). 0: done; 1: refused (nothing
// written); 2: usage. Every proxy is read before anything is written.
export async function runCamerasConfig(argv: string[], env: NodeJS.ProcessEnv, io: { out: (line: string) => void; err: (line: string) => void }, now: () => Date = () => new Date()): Promise<number> {
  let output = 'cameras.json', input: string | undefined, write = false, prune = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') write = true;
    else if (a === '--prune') prune = true;
    else if ((a === '--output' || a === '--input') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      if (a === '--output') output = argv[++i];
      else input = argv[++i];
    } else return io.err(USAGE), 2;
  }
  output = resolve(output);
  input = resolve(input ?? join(dirname(output), 'cameras-config.json'));
  try {
    const st = await fs.stat(input).catch(() => {
      throw new ImportError(`${input} not found`);
    });
    if (st.mode & 0o077) throw new ImportError(`${input} is readable by others: chmod 600 it (it holds tokens and passwords)`);
    const proxies = parseImportInput(await fs.readFile(input, 'utf8'), dirname(input), env);
    let existing: Entry[] = [];
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(output, 'utf8'));
      if (!Array.isArray(parsed)) throw new ImportError(`${output} is not a JSON array`);
      existing = parsed as Entry[];
    } catch (err) {
      if (err instanceof ImportError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ImportError(`${output} is not valid JSON`);
    }
    const read = [];
    for (const proxy of proxies) read.push({ proxy, cameras: await readProxyCameras(proxy) });
    const { entries, notes } = buildCameras(existing, read, { prune });
    const lines = diffCameras(existing, entries);
    for (const l of lines.length ? lines : ['(no changes)']) io.out(l);
    for (const n of notes) io.out(`note: ${n}`);
    if (!write) return io.out(`Dry run: nothing written. Run again with --write to write ${output}.`), 0;
    if (!lines.length) return io.out('Nothing to write.'), 0;
    const tmp = `${output}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (existing.length || (await fs.stat(output).then(() => true, () => false))) {
        await fs.copyFile(output, `${output}.bak-${stamp(now())}`);
        await fs.chmod(`${output}.bak-${stamp(now())}`, 0o600);
      }
      await fs.rename(tmp, output);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw new ImportError(`could not write ${output} (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})`);
    }
    io.out(`Wrote ${output} (${entries.length} cameras).`);
    return 0;
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    io.err(err.message);
    return 1;
  }
}
```

- [ ] **Step 4: The script, type-checking, ignore, README**

```ts
// scripts/cameras-config.ts
// Writes cams's cameras.json from a short list of cam-proxies (cam-proxy
// spec 2026-10-05 §13.3). Dry run by default; --write to write.
//   npx tsx scripts/cameras-config.ts [--output cameras.json] [--input cameras-config.json] [--write] [--prune]
// The input (mode 600, never committed) holds the tokens and passwords, or
// {"env": "NAME"} / {"file": "path"} for each; nothing secret goes on the
// command line, and nothing secret is printed.
import { runCamerasConfig } from '../server/cameraImport';

void runCamerasConfig(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => {
  process.exitCode = code;
});
```

`tsconfig.check.json`: `"include": ["server", "test", "e2e", "scripts/**/*.ts", "playwright.config.ts", "vitest.config.mts"]`.
`.gitignore`: add the line `cameras-config.json`.
`README.md`, at the end of § Cameras, add:

```markdown
### Generating cameras.json

`npx tsx scripts/cameras-config.ts` writes `cameras.json` from a short list of cam-proxies (cam-proxy spec 2026-10-05 §13.3), one entry per camera each proxy serves. Its input, `cameras-config.json` next to the output (mode 600, never committed; `--input` for another path), is `{"proxies": [ … ]}`, one object per proxy: `url`, `token`, optional `adminToken`, `cameraUser` and `cameraPassword` (the cams camera user, which the proxy doesn't know), optional `prefix` for new ids, `tlsServername` and `caFingerprint` for a proxy with a site CA, `protocol` for one without, and `cameras: {"<proxy id>": {id, name, user, password, protocol, tlsServername, host, webUiUrl, webUiNote}}` to override one camera. Every secret can be `{"env": "NAME"}` or `{"file": "path"}` instead. It reads every proxy first (`/tls/ca.pem` against the pin, then `GET /api/cameras`) and prints a diff (secrets as `•••`); `--write` writes it (mode 600, the old file kept as `cameras.json.bak-<time>`), `--prune` drops cameras a proxy no longer lists. A camera keeps its id and name across runs; an id used twice, an unreachable proxy or a wrong pin stops it with nothing written. Entries without a proxy, and proxies not in the input, stay as they are. In the cluster the result becomes the `cams-cameras` Secret (kube-setup).
```

- [ ] **Step 5: Run tests and type check**

Run: `npx vitest run test/camerasConfigCli.test.ts test/cameraImport.test.ts && npm run lint:types`
Expected: PASS; `lint:types` exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/cameraImport.ts scripts/cameras-config.ts tsconfig.check.json .gitignore README.md test/camerasConfigCli.test.ts
git commit -m "feat: scripts/cameras-config.ts writes cameras.json from a list of cam-proxies"
```

---

### Task 11: Real-proxy e2e with a two-camera cam-proxy (Silo and Loft)

**Precondition:** cam-proxy's P1+P2 (`cameras[]` in config.json) is released. Find the tag with `gh release list -R klaushofrichter/cam-proxy` and its index digest with `docker buildx imagetools inspect ghcr.io/klaushofrichter/cam-proxy:<tag>` (the `Digest:` line). If it is not released yet, leave this task unchecked and do the others.

**Files:**
- Modify: `e2e/env.ts` (`CAM_PROXY_TAG`, `CAM_PROXY_DIGEST`), `e2e/sims.ts` (`loft`), `e2e/realProxy.ts` (config `cameras`), `e2e/cameras.json` (`loft`), `e2e/shell.spec.ts:14` (picker list), `playwright.config.ts` (comment: six sims)
- Test: `e2e/realProxy.spec.ts` (new test)

**Interfaces:**
- Consumes: the released cam-proxy's `cameras[]` config (spec §4.1) and `?cam=a,b` stream (§6.2).
- Produces: e2e camera `loft` "Loft" (cam-sim ports http 8086, https 8186, control 8286, onvif 8386, rtsp 8486, baichuan 8586), on the real cam-proxy with Silo.

- [ ] **Step 1: Add the camera and the test**

`e2e/sims.ts`: the record type becomes `Record<'den' | 'porch' | 'shed' | 'barn' | 'silo' | 'loft', Sim>` and gains

```ts
  // Loft: Silo's neighbour on the same real cam-proxy (a two-camera host,
  // cam-proxy spec 2026-10-05), refusing HTTP Download like Silo.
  loft: { name: 'Loft', http: 8086, https: 8186, control: 8286, onvif: 8386, rtsp: 8486, baichuan: 8586, faults: [STRICT, { name: 'downloads.refuse' }] },
```

`e2e/realProxy.ts`: replace the `camera: {…}` line of the config with

```ts
    cameras: [
      { id: 'silo', name: 'Silo', host: `127.0.0.1:${s.http}`, protocol: 'http', user: 'e2e', onvifPort: s.onvif, rtspPort: s.rtsp, baichuanPort: s.baichuan, statusPollS: 5 },
      { id: 'loft', name: 'Loft', host: `127.0.0.1:${l.http}`, protocol: 'http', user: 'e2e', onvifPort: l.onvif, rtspPort: l.rtsp, baichuanPort: l.baichuan, statusPollS: 5 },
    ],
```

with `const l = SIMS.loft;` next to `const s = SIMS.silo;`.

`e2e/cameras.json`: append

```json
  {"id": "loft", "name": "Loft", "host": "127.0.0.1:8086", "protocol": "http", "user": "e2e", "password": "e2e-not-a-real-password", "webUiNote": "Website not available - simulated camera", "proxy": {"url": "http://127.0.0.1:8091", "token": "e2e-real-proxy-token-not-a-secret-000000"}}
```

`e2e/shell.spec.ts:14`: the expected picker list ends `'Barn', 'Silo', 'Loft'`. Run `grep -rn "'Silo'\]" e2e` and append `'Loft'` the same way wherever a full camera list is asserted.

`e2e/env.ts`: set `CAM_PROXY_TAG` and `CAM_PROXY_DIGEST` to the release found above.

`e2e/realProxy.spec.ts`: append

```ts
// Two cameras on one cam-proxy (cam-proxy spec 2026-10-05 §12.2): cams
// keeps one event stream to it and gives each camera its own events.
test('Silo and Loft share one cam-proxy, each with its own events', async ({ page }) => {
  await page.goto('/app/recordings?cam=loft&panel=events');
  await expect.poll(() => eventCount(page), { timeout: 30_000 }).toBe(4);
  await expect(page.getByTestId('recordings-source')).toHaveText('Source of recordings and thumbnails: cam-proxy (SD card)');
  const list = (await (await page.request.get(`http://127.0.0.1:${REAL_PROXY.port}/api/cameras`, { headers: { Authorization: `Bearer ${REAL_PROXY.token}` } })).json()) as { id: string }[];
  expect(list.map((c) => c.id)).toEqual(['silo', 'loft']);
  // One upstream stream per cams server (the main one and the token-login one), not one per camera.
  const status = (await (await page.request.get(`http://127.0.0.1:${REAL_PROXY.port}/control/status`, { headers: { Authorization: `Bearer ${REAL_PROXY.adminToken}` } })).json()) as { sse: { clients: number } };
  expect(status.sse.clients).toBe(2);
  // A person event on Loft's cam-sim reaches Loft's page through the shared stream, and not Silo's.
  const fired = await page.request.post(`http://127.0.0.1:${SIMS.loft.control}/sim/api/events`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` }, data: { type: 'person', durationS: 5 } });
  expect(fired.ok()).toBe(true);
  await expect.poll(() => eventCount(page), { timeout: 60_000 }).toBe(5);
  await page.goto('/app/recordings?cam=silo&panel=events');
  await expect.poll(() => eventCount(page), { timeout: 30_000 }).toBe(4);
});
```

with `import { CONTROL_TOKEN, SIMS } from './sims';` added.

- [ ] **Step 2: Run the unit suite and type check (the e2e itself runs in CI only)**

Run: `npm test && npm run build && npm run lint:types`
Expected: PASS; build and lint exit 0. Never run `CAMS_E2E_REAL_PROXY=1` on a Mac or the home LAN.

- [ ] **Step 3: Commit, then let CI run the e2e**

```bash
git add e2e/env.ts e2e/sims.ts e2e/realProxy.ts e2e/cameras.json e2e/shell.spec.ts e2e/realProxy.spec.ts playwright.config.ts
git commit -m "test(e2e): two cameras on one real cam-proxy (Silo and Loft)"
```

Expected in the PR's `e2e` check: `realProxy.spec.ts` both tests pass on desktop and phone.

---

### Task 12: Livestack multi-camera variant (cams → one cam-proxy → 3 cam-sims, HTTP)

**Precondition:** cam-proxy P1+P2 merged to its `origin/main` (the livestack builds `origin/main`).

**Files:**
- Create: `scripts/livestack/start-multi-stack.sh`, `scripts/livestack/check-multi.sh`
- Modify: `scripts/livestack/stop-stack.sh` (nothing if it stops by the recorded PIDs; check), `docs/livestack.md` (a "Multi-camera stack" section)

**Interfaces:**
- Consumes: `lib.sh` helpers (`new_run`, `require_ports_free`, `prepare_repo`, `gen_token`, `put_secret`, `runenv_put`, `start_bg`, `wait_http`, `start_proxy`, `start_cams`, `validate_proxy_config`, `validate_cams_cameras`, `env_get`, `note`, `die`), `scripts/cameras-config.ts` (Task 10).
- Produces: a stack on 127.0.0.1: cam-sims `sima`/`simb`/`simc` (http 19081-19083, https 19444-19446, control 19944-19946, rtsp 19561-19563, onvif 19801-19803, baichuan 19901-19903), cam-proxy 19482 (go2rtc 19565/19985, FTPS 19222, passive 19240-19269), cams 19582; `check-multi.sh` with 6 checks.

- [ ] **Step 1: Write `start-multi-stack.sh`**

Copy `start-sim-stack.sh` to `start-multi-stack.sh` and change:
- header: "the multi-camera stack, three cam-sims → one cam-proxy → cams (cam-proxy spec 2026-10-05 §15 "livestack"), all local, over HTTP" and the port list above;
- `CAMS=(sima simb simc)`; one `start_bg cam-sim-$id …` per camera with its ports, `CAMSIM_NAME` `Sim A`/`Sim B`/`Sim C`, `CAMSIM_FTP_USER=$id`, each with its own `CAMSIM_DATA_DIR="$RUN/camsim-$id"`; one `wait_http …/healthz` each;
- the proxy config: `cameras: [ {id: "sima", name: "Sim A", host: "127.0.0.1:19081", protocol: "http", user: "proxy", onvifPort: 19801, rtspPort: 19561, baichuanPort: 19901, statusPollS: 5, ftp: {user: "sima"}}, … ]` instead of `camera`, `ftp.user` removed at the top level, `ftp.passive: "19240-19269"`;
- the cams `cameras.json` comes from the generator, not jq:

```bash
( umask 077; jq -n --arg url "http://127.0.0.1:$PROXY_PORT" '{ proxies: [ {
    url: $url, token: {file: "secrets/proxy_tokens"}, adminToken: {file: "secrets/proxy_admin_token"},
    cameraUser: "cams", cameraPassword: {file: "secrets/cams_camera_password"}, protocol: "http",
    cameras: { sima: {webUiNote: "Simulated camera (livestack)"}, simb: {webUiNote: "Simulated camera (livestack)"}, simc: {webUiNote: "Simulated camera (livestack)"} } } ] }' \
  > "$RUN/cameras-config.json" )
put_secret cams_camera_password "$CAM_PW_CAMS"
( cd "$WORK/src-cams" && npx tsx scripts/cameras-config.ts --input "$RUN/cameras-config.json" --output "$RUN/cams/cameras.json" --write )
validate_cams_cameras "$RUN/cams/cameras.json"
```

  (the generator runs after cam-proxy is up, so move the cams step below `start_proxy … wait_http`);
- one 20 s person event on `simb` only.

- [ ] **Step 2: Write `check-multi.sh`**

```bash
#!/usr/bin/env bash
# check-multi.sh: checks of the multi-camera stack (start-multi-stack.sh):
# one cam-proxy, three cameras, one event stream from cams.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
PROXY=http://127.0.0.1:19482 CAMS=http://127.0.0.1:19582
# (header files for the client token and the cams cookie: copy the block from check-stack.sh)
# 1. the proxy lists sima, simb, simc in config order
# 2. cams lists the three cameras (GET /api/cameras): ids sima, simb, simc, proxy true
# 3. cams holds one upstream stream: the proxy's GET /control/status reports one SSE client
# 4. each camera has stills through cams (GET /api/cameras/<id>/stills for the last 2 min, non-empty)
# 5. simb's person event is listed for simb and not for sima (GET /api/cameras/<id>/events for today)
# 6. the Archive lists one proxy with three cameras (GET /api/archive/proxies or the merged list's `proxies`)
```

Write each check with the `row`/`get` helpers of `check-stack.sh` (copy them), e.g. check 1:

```bash
get proxy_cams "$PROXY/api/cameras" "$TMP/h_client"
ids="$(jq -r '[.[].id] | join(",")' "$TMP/proxy_cams.body" 2>/dev/null)"
[ "$CODE" = 200 ] && [ "$ids" = "sima,simb,simc" ] && row PASS "proxy lists 3 cameras" "$ids" || row FAIL "proxy lists 3 cameras" "$CODE $ids"
```

Check 3 reads the SSE client count from cam-proxy's `/control/status` with the admin header (`jq '.sse.clients'`, `src/api/control-api.ts:263` on cam-proxy main) and expects `1`. Exit 1 if any FAIL.

- [ ] **Step 3: Document**

`docs/livestack.md`: add a "Multi-camera stack" section with the ports above, `start-multi-stack.sh`, `check-multi.sh`, `stop-stack.sh`, and that it uses `scripts/cameras-config.ts` to write cams's `cameras.json`.

- [ ] **Step 4: Run it**

Run: `scripts/livestack/start-multi-stack.sh && sleep 60 && scripts/livestack/check-multi.sh; scripts/livestack/stop-stack.sh`
Expected: `6 of 6 checks passed` (or the script's equivalent summary line), exit 0. It binds only 127.0.0.1 and never touches the Pi or the real camera.

- [ ] **Step 5: Commit**

```bash
git add scripts/livestack/start-multi-stack.sh scripts/livestack/check-multi.sh docs/livestack.md
git commit -m "test(livestack): a multi-camera stack, three cam-sims on one cam-proxy"
```

---

### Task 13: Docs, CHANGELOG and the full gate

**Files:**
- Modify: `README.md` (§ Cameras, the `proxy` row), `CHANGELOG.md` (`## [Unreleased]`), `docs/pi-demo.md` (one line: unchanged)

- [ ] **Step 1: README**

In the `proxy` row of the § Cameras table, after "`camera` is the proxy's id for this camera when it differs from `id`." add: "Several cameras may name the same proxy (same `url` and `token`): cams then keeps one event stream to it (`?cam=` with their proxy ids) and one Archive entry, and reads its camera list once for all of them; their `adminToken`s, where set, must be the same."

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]`:

```markdown
### Added
- Several cameras can share one cam-proxy (a multi-camera host): cams keeps one event stream per proxy and gives each camera its own events.
- `scripts/cameras-config.ts` writes `cameras.json` from a short list of cam-proxies (dry run by default, `--write`, `--prune`), checking a proxy's site CA against its pinned fingerprint.
```

- [ ] **Step 3: Pi note**

In `docs/pi-demo.md`, where `cameras.json` is described, add: "A one-camera `cameras.json` like `deploy/pi/cameras.example.json` keeps working unchanged with multi-camera cam-proxies; `scripts/cameras-config.ts` can write it (see README, Generating cameras.json)."

- [ ] **Step 4: The full gate**

Run: `npm test && npm run build && npm run check && npm run lint:types`
Expected: all pass, exit 0. (e2e runs in CI on the PR.)

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/pi-demo.md
git commit -m "docs: cameras sharing a cam-proxy; the cameras.json generator"
```
