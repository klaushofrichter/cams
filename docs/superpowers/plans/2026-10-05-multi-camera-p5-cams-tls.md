# Multi-camera P5 (cams: site CA trust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cams pins one CA fingerprint per site-CA cam-proxy, fetches and checks the CA from `/tls/ca.pem`, and then trusts only that CA for the proxy's HTTPS URL and for every camera of that proxy, with a per-camera leaf pin (reported by the proxy over the verified channel) for a camera that refused the import; the Pi's cam1 keeps its Let's Encrypt / `tlsServername` path unchanged.

**Architecture:** `cameras.json`'s proxy object gains `caFingerprint` (one or a list) and `tlsServername`; a proxy group (P3's `server/proxy/groups.ts`) carries them. `server/tls/store.ts` keeps the verified CAs and the fallback pins on disk (next to the proxy-state file) so cameras stay reachable while their proxy is away; `server/tls/groupCa.ts` fetches a group's CA against its pin (P3's `fetchPinnedCa`) and hands the proxy client an undici dispatcher that trusts only it. Every camera request goes through one choke point (`openRequest` in `server/reolink/http.ts`), which now takes a `CameraTrust` (`public` | `site-ca` | `pinned` | `none` | `unavailable`) resolved per camera by `server/tls/cameraTrust.ts`.

**Tech Stack:** Node 26 (`tls`, `https`, `crypto.X509Certificate`), TypeScript 7, undici 8 (added in P3), vitest 5, the P3 fixtures in `test/fixtures/site-ca/`, the fake cam-proxy in HTTPS mode (P3 Task 6).

**Spec:** cam-proxy `docs/superpowers/specs/2026-10-05-multi-camera-host-design.md` (cam-proxy PR #168), §10.1 (item 4), §10.2, §10.3, §10.4 (the `tls` block), §10.7, §11, §12.1, §12.3, §13.2, §15 ("cams", "livestack"), §16 row P5. Depends on `docs/superpowers/plans/2026-10-05-multi-camera-p3-cams.md` (groups, `server/tls/fingerprint.ts`, `server/tls/siteCa.ts`, the HTTPS fake proxy, the generator).

## Global Constraints

- cams pins one thing per proxy: the CA's SHA-256 fingerprint; it fetches `GET /tls/ca.pem` (public, no token), accepts it only if its fingerprint matches the pin, caches it, and uses it as the **only** trust anchor for that proxy's HTTPS URL and for the cameras of that proxy (spec §10.1.4).
- Fallback: a camera that refused the import is reported by the proxy as `tls: {mode: "pinned", fingerprint}` in `GET /api/cameras`; cams pins it automatically for that camera; no manual pin (spec §10.1.4); the last one seen is kept in the data dir so the camera stays reachable while its proxy is away (spec §12.3).
- Leaf pin check: the SHA-256 of the leaf, nothing else (spec §12.3).
- `caFingerprint` is a string or a list (CA rotation: a new CA can be pinned before the old one goes, spec §10.7).
- Within a proxy group, `caFingerprint` and `tlsServername` must be equal, else startup fails naming both entries (spec §12.1).
- Names: the proxy's URL is `https://<LAN address>:8443` with `tlsServername` `proxy.<site>.internal`; a camera's `tlsServername` is `<camId>.<site>.internal` (spec §10.3).
- `from-proxy` stays valid with a site-CA pin (spec §10.2), documented in cams's docs.
- The Pi keeps `http://127.0.0.1:8480` (cams on the Pi) / `http://192.168.1.220:8480` (cams in the cluster), no pin, and cam1's Let's Encrypt certificate checked against `cam1.skylar.technology` (spec §11, §12.3); a proxy without a site CA (the Pi, the cluster proxy) has no pin and keeps its current trust (spec §13.2).
- The cluster's `cams-cameras` Secret is changed by Klaus through kube-setup, never from here (spec §14.4).
- Never log camera passwords, tokens, cookies or client IPs; CA fingerprints are not secret and may be logged.
- Never touch the Pi, the cluster or a real camera; certificate imports on real cameras are measured in cam-proxy P4 (spec §15), not here.

## Review Focus

1. **The proxy rotates its CA** (pins `[A, B]`, the proxy now serves a leaf from B): cams notices the failed handshake, fetches `/tls/ca.pem` again, checks it against the list and carries on → test in Task 3 ("follows a CA rotation within the pinned list").
2. **cams restarts while the proxy is away**: the camera's direct features (live, snapshot, settings) still verify against the CA cached on disk → test in Task 5 ("uses the cached CA after a restart while the proxy is away").
3. **A leaf pin that doesn't match** (the camera was reset or replaced, and the proxy hasn't reported the new fingerprint yet): no request byte reaches that host (the Login body carries the cams user's password), and the error is a certificate error, not "offline" → test in Task 4 ("sends nothing when the pin doesn't match").
4. **A wrong CA pin**: the client token is never sent to that proxy; only `/tls/ca.pem` is requested → test in Task 3 ("never sends the token past a wrong pin").
5. **The Pi's configuration** (no pin, http proxy URL, cam1 with `tlsServername`): no `/tls/ca.pem` request, cam1 still verified by public CAs against its name → test in Task 5 ("keeps the Pi’s Let’s Encrypt path").

---

## Rulings (spec gaps, decided here)

- **Ruling: a leaf pin is checked on the TLS socket at `secureConnect`, before the request is written, with `rejectUnauthorized: false` — not with `checkServerIdentity`** — why: spec §12.3 proposes `rejectUnauthorized: false` plus a `checkServerIdentity`, but Node calls `checkServerIdentity` only when the chain verified; for a self-signed factory certificate (`CN=CERTIFICATE`) it is never called, so that check would accept any certificate (a spec contradiction) — cost if wrong: none for security; a custom `createConnection` on the request instead of a plain option.
- **Ruling: `/tls/ca.pem` is fetched without verifying the proxy's certificate** — why: that certificate is signed by the CA being fetched; the PEM's fingerprint against the pin is the check (spec §10.1.4) — cost if wrong: none; nothing but the PEM is read on that connection, and no token is sent.
- **Ruling: a pinned proxy may have an `http://` URL only on the proxy's own host (127.0.0.0/8, `[::1]`, `localhost`)** — why: spec §12.1 says the proxy URL is verified against the CA, while §12.3 keeps `http://127.0.0.1:8480` for cams on the same host; a pin on a LAN `http://` URL would protect the cameras but leave the token in clear — cost if wrong: a LAN `http://` URL with a pin is refused at startup with a message saying why.
- **Ruling: `from-proxy` needs `https` and a camera `tlsServername` *or* a proxy `caFingerprint`** — why: a camera on the leaf-pin fallback has no usable name (factory `CN=CERTIFICATE`); its trust is the pin, reported over the pinned channel (spec §10.1.4, §10.2) — cost if wrong: none; without a pin the old rule applies.
- **Ruling: a site-CA camera without `tlsServername` is checked against its address (the leaf's IP SAN)** — why: spec §10.1.2 puts `IP:<camera address>` in every camera leaf — cost if wrong: such a camera fails TLS until the generator writes its name.
- **Ruling: fallback pins are taken only from groups with a `caFingerprint`, set on `mode: "pinned"` with a valid fingerprint, cleared on `mode: "site-ca"`, left as they are for any other mode** — why: spec §10.1.4 "arrives over the already verified proxy channel"; "the last one seen is kept" (§12.3) — cost if wrong: a camera moved from `pinned` to `public` keeps its old pin until the proxy reports `site-ca`.
- **Ruling: the camera list (and with it the fallback pins) is read when a proxy's stream comes up and every 15 minutes while it is up** — why: the spec says when cams pins but not how often it looks; a camera replaced while the stream stays up must be picked up without a restart — cost if wrong: up to 15 minutes until a replaced camera works again.
- **Ruling: the verified CAs and fallback pins live in `proxy-tls.json` next to the proxy-state file (`PROXY_TLS_FILE` overrides), mode 600, CAs re-checked against their fingerprint on load** — why: spec §12.3 "kept (data dir)"; the cams-data volume already holds `proxy-state.json` — cost if wrong: a deleted file means the CA is fetched again on the next start (the proxy must answer then).
- **Ruling: CA and pin failures keep today's error codes** (`proxy_unreachable` for the proxy, `camera_error` "TLS certificate check failed (…)" for a camera) — why: the browser already shows both; a new code would need UI work the spec doesn't ask for — cost if wrong: the reason is in the server log (`ERR_TLS_CERT_PIN_MISMATCH`, `ca_pin_mismatch`), not in a dedicated UI message.
- **Ruling: the livestack HTTPS variant (Task 8) waits for cam-proxy P5 on `origin/main`** — why: it needs the proxy's site CA, `/tls/ca.pem` and cert push — cost if wrong: that one task starts later.

## File Structure

| File | Responsibility |
|---|---|
| `server/cameraRegistry.ts` | `proxy.caFingerprint` / `proxy.tlsServername` parsing, the loopback rule, group equality, the relaxed `from-proxy` rule |
| `server/proxy/groups.ts` | `ProxyGroup.pins`, `ProxyGroup.tlsServername` |
| `server/tls/store.ts` (new) | verified CAs and fallback pins, persisted; `trustEvents` |
| `server/tls/groupCa.ts` (new) | `ensureGroupCa()`, `groupDispatcher()`, `groupTlsFailed()` |
| `server/proxy/client.ts` | `ProxyClient` with a dispatcher; `groupTrustOptions()` |
| `server/proxy/stream.ts` | fetch pinned groups' CAs at start |
| `server/routes/proxy.ts` | the admin (login-link) client uses the group's trust |
| `server/reolink/http.ts` | `CameraTrust`, `tlsOptions()`, `pinnedConnection()` |
| `server/reolink/client.ts` | `opts.trust`, `cameraCertificate()` per trust |
| `server/tls/cameraTrust.ts` (new) | `cameraTrust(cam)`, `applyProxyTls(id, tls)` |
| `server/reolink/clients.ts` | build with the camera's trust; rebuild on `trustEvents` |
| `server/proxy/names.ts` | apply the `tls` block; 15-minute list refresh |
| `server/server.ts` | `loadTlsState()` at start |
| `test/proxyTlsConfig.test.ts`, `test/tlsStore.test.ts`, `test/proxyTls.test.ts`, `test/cameraTls.test.ts`, `test/cameraTrust.test.ts`, `test/fallbackPin.test.ts`, `test/siteCaEndToEnd.test.ts`, `test/helpers/tlsCamera.ts` (new) | tests |
| `scripts/livestack/start-multi-stack.sh`, `scripts/livestack/check-multi.sh`, `docs/livestack.md` | the HTTPS variant |
| `README.md`, `CHANGELOG.md`, `docs/pi-demo.md` | docs |

---

### Task 1: `caFingerprint` and the proxy's `tlsServername` in `cameras.json`

**Files:**
- Modify: `server/cameraRegistry.ts` (`CameraConfig.proxy`, `proxyOf`, the `from-proxy` check, `checkProxyGroups`), `server/proxy/groups.ts` (`ProxyGroup`)
- Modify: `test/cameraAddress.test.ts:56,58` (the `from-proxy` message)
- Test: `test/proxyTlsConfig.test.ts` (new)

**Interfaces:**
- Consumes: `fingerprintList` (P3 Task 5), `proxyGroupKey`, `proxyGroups()` (P3 Task 2).
- Produces:
  - `CameraConfig.proxy: { url: string; token: string; adminToken?: string; camera?: string; caFingerprint?: string[]; tlsServername?: string }` (`caFingerprint` normalized to a list of 64-hex strings)
  - `ProxyGroup.pins: string[] | null`, `ProxyGroup.tlsServername: string | null`

- [ ] **Step 1: Write the failing test**

```ts
// test/proxyTlsConfig.test.ts
// cameras.json for a site-CA cam-proxy (cam-proxy spec 2026-10-05 §12.1):
// proxy.caFingerprint (one or a list) and proxy.tlsServername.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCameras, setCameras } from '../server/cameraRegistry';
import { groupOf } from '../server/proxy/groups';

const T = 't'.repeat(40), A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const file = (body: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'cams-tlscfg-')), 'cameras.json');
  writeFileSync(f, JSON.stringify(body));
  return f;
};
const proxy = { url: 'https://192.168.1.230:8443', token: T, tlsServername: 'proxy.garage.internal', caFingerprint: `SHA256:${A.toUpperCase().match(/../g)!.join(':')}` };
const entry = (id: string, p: object = proxy, more: object = {}) => ({ id, name: id, host: 'from-proxy', protocol: 'https', tlsServername: `${id}.garage.internal`, user: 'cams', password: 'pw', proxy: { ...p, camera: id }, ...more });
afterEach(() => setCameras([]));

describe('site-CA proxy fields', () => {
  it('normalizes the pin to a list and keeps the TLS name', () => {
    const [c] = loadCameras(file([entry('cam3')]));
    expect(c.proxy).toEqual({ url: 'https://192.168.1.230:8443', token: T, camera: 'cam3', tlsServername: 'proxy.garage.internal', caFingerprint: [A] });
  });

  it('takes a rotation list', () => {
    expect(loadCameras(file([entry('cam3', { ...proxy, caFingerprint: [A, `sha256:${B}`] })]))[0].proxy?.caFingerprint).toEqual([A, B]);
  });

  it('puts pins and name on the group', () => {
    setCameras(loadCameras(file([entry('cam3'), entry('cam4')])));
    expect(groupOf('cam4')).toMatchObject({ members: ['cam3', 'cam4'], pins: [A], tlsServername: 'proxy.garage.internal' });
  });

  it('refuses a bad pin, a bad name, a name on http and a pin on a LAN http URL', () => {
    expect(() => loadCameras(file([entry('cam3', { ...proxy, caFingerprint: 'nope' })]))).toThrow('camera registry entry 0: proxy caFingerprint must be a SHA-256 fingerprint (64 hex digits, "SHA256:" optional) or a list of them');
    expect(() => loadCameras(file([entry('cam3', { ...proxy, tlsServername: 'has space' })]))).toThrow('camera registry entry 0: proxy tlsServername must be a host name');
    expect(() => loadCameras(file([entry('cam3', { url: 'http://192.168.1.230:8480', token: T, tlsServername: 'proxy.garage.internal' })]))).toThrow('camera registry entry 0: proxy tlsServername needs an https url');
    expect(() => loadCameras(file([entry('cam3', { url: 'http://192.168.1.230:8480', token: T, caFingerprint: A })]))).toThrow(
      'camera registry entry 0: proxy url must be https with a caFingerprint (http only on the proxy’s own host: 127.0.0.1, ::1 or localhost)',
    );
  });

  it('accepts a pin on the proxy’s own host over http (cams next to the proxy, spec §12.3)', () => {
    expect(loadCameras(file([entry('cam3', { url: 'http://127.0.0.1:8480', token: T, caFingerprint: A })]))[0].proxy?.caFingerprint).toEqual([A]);
  });

  it('refuses one proxy with two pins or two names, naming both entries', () => {
    expect(() => loadCameras(file([entry('cam3'), entry('cam4', { ...proxy, caFingerprint: B })]))).toThrow('camera registry entries 0 ("cam3") and 1 ("cam4"): same cam-proxy (url and token) but different caFingerprint');
    expect(() => loadCameras(file([entry('cam3'), entry('cam4', { ...proxy, tlsServername: 'other.garage.internal' })]))).toThrow('camera registry entries 0 ("cam3") and 1 ("cam4"): same cam-proxy (url and token) but different tlsServername');
    const { caFingerprint: _c, ...noPin } = proxy;
    expect(() => loadCameras(file([entry('cam3'), entry('cam4', noPin)]))).toThrow('different caFingerprint');
  });

  it('lets a from-proxy camera of a pinned proxy go without a TLS name (the leaf-pin fallback)', () => {
    const { tlsServername: _n, ...noName } = entry('cam5');
    expect(loadCameras(file([noName]))[0].tlsServername).toBeUndefined();
    const unpinned = { ...noName, proxy: { url: 'http://127.0.0.1:8480', token: T } };
    expect(() => loadCameras(file([unpinned]))).toThrow('camera registry entry 0: host "from-proxy" needs protocol "https" and a tlsServername (or a proxy caFingerprint)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxyTlsConfig.test.ts`
Expected: FAIL: "normalizes the pin…" gets a proxy object without `caFingerprint`/`tlsServername`.

- [ ] **Step 3: Implement the registry fields**

In `server/cameraRegistry.ts`:
- `import { fingerprintList } from './tls/fingerprint';`
- `CameraConfig.proxy` type: `proxy?: { url: string; token: string; adminToken?: string; camera?: string; caFingerprint?: string[]; tlsServername?: string };` with the comment line "`caFingerprint`: the proxy's site CA, one or a list (rotation); `tlsServername`: the name on the proxy's certificate (cam-proxy spec 2026-10-05 §12.1)".
- in `proxyOf`, after the `camera` check:

```ts
  const LOOPBACK = /^(127(\.\d{1,3}){3}|\[::1\]|localhost)$/i;
  let caFingerprint: string[] | undefined;
  if (p.caFingerprint !== undefined) {
    caFingerprint = fingerprintList(p.caFingerprint) ?? fail('caFingerprint must be a SHA-256 fingerprint (64 hex digits, "SHA256:" optional) or a list of them');
    if (url!.protocol === 'http:' && !LOOPBACK.test(url!.hostname)) fail('url must be https with a caFingerprint (http only on the proxy’s own host: 127.0.0.1, ::1 or localhost)');
  }
  if (p.tlsServername !== undefined) {
    if (typeof p.tlsServername !== 'string' || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(p.tlsServername)) fail('tlsServername must be a host name');
    if (url!.protocol !== 'https:') fail('tlsServername needs an https url');
  }
```

  and the returned object gains `...(caFingerprint && { caFingerprint }), ...(p.tlsServername !== undefined && { tlsServername: p.tlsServername as string }),`. (`fail` returns `never`, so `?? fail(…)` types as `string[]`.)
- the `from-proxy` check becomes:

```ts
    const pinned = typeof e.proxy === 'object' && e.proxy !== null && (e.proxy as Record<string, unknown>).caFingerprint !== undefined;
    if (e.host === FROM_PROXY && ((e.protocol ?? 'https') !== 'https' || (e.tlsServername === undefined && !pinned))) {
      throw new Error(`camera registry entry ${i}: host "${FROM_PROXY}" needs protocol "https" and a tlsServername (or a proxy caFingerprint)`);
    }
```

- `checkProxyGroups` gains a second map over every proxied entry:

```ts
  const first = new Map<string, { i: number; id: string; pins: string; name: string }>();
  list.forEach((c, i) => {
    if (!c.proxy) return;
    const key = proxyGroupKey(c.proxy);
    const mine = { i, id: c.id, pins: (c.proxy.caFingerprint ?? []).join(','), name: c.proxy.tlsServername ?? '' };
    const f = first.get(key);
    if (!f) return void first.set(key, mine);
    for (const [field, a, b] of [['caFingerprint', f.pins, mine.pins], ['tlsServername', f.name, mine.name]] as const) {
      if (a !== b) throw new Error(`camera registry entries ${f.i} ("${f.id}") and ${i} ("${c.id}"): same cam-proxy (url and token) but different ${field}`);
    }
  });
```

In `server/proxy/groups.ts`: `ProxyGroup` gains `pins: string[] | null; // the site CA's fingerprints (spec §12.1); null: no site CA` and `tlsServername: string | null; // the name on the proxy's certificate`, set from the first member when the group is created: `pins: c.proxy.caFingerprint ?? null, tlsServername: c.proxy.tlsServername ?? null`.

In `test/cameraAddress.test.ts` lines 56 and 58 the expected message becomes `'camera registry entry 0: host "from-proxy" needs protocol "https" and a tlsServername (or a proxy caFingerprint)'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/proxyTlsConfig.test.ts test/cameraAddress.test.ts test/cameraRegistry.test.ts test/proxyGroups.test.ts test/cameraImport.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/cameraRegistry.ts server/proxy/groups.ts test/proxyTlsConfig.test.ts test/cameraAddress.test.ts
git commit -m "feat: cameras.json pins a cam-proxy's site CA (caFingerprint, tlsServername)"
```

---

### Task 2: The TLS store: verified CAs and fallback pins, on disk

**Files:**
- Create: `server/tls/store.ts`
- Modify: `server/server.ts` (call `loadTlsState()` after `loadProxyState()`)
- Test: `test/tlsStore.test.ts` (new)

**Interfaces:**
- Consumes: `certFingerprint`, `normalizeFingerprint` (P3 Task 5).
- Produces:
  - `loadTlsState(): void`
  - `verifiedCas(pins: string[]): string[]` (the cached PEMs whose fingerprint is in `pins`, in `pins` order)
  - `addVerifiedCa(fingerprint: string, pem: string): Promise<void>`
  - `fallbackPin(cam: string): string | undefined`
  - `setFallbackPin(cam: string, fingerprint: string | null): Promise<void>` (emits `trustEvents` `'trust' {cam}` on a change)
  - `trustEvents: EventEmitter`

- [ ] **Step 1: Write the failing test**

```ts
// test/tlsStore.test.ts
// What cams keeps of its proxies' TLS (cam-proxy spec 2026-10-05 §12.3):
// the verified site CAs and the fallback leaf pins, across restarts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { certFingerprint } from '../server/tls/fingerprint';
import { addVerifiedCa, fallbackPin, loadTlsState, setFallbackPin, trustEvents, verifiedCas } from '../server/tls/store';

const pem = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', `${n}.pem`), 'utf8');
const CA_A = pem('ca-a'), CA_B = pem('ca-b');
const A = certFingerprint(CA_A), B = certFingerprint(CA_B), LEAF = 'cc'.repeat(32);
let file: string;
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'cams-tls-')), 'proxy-tls.json');
  process.env.PROXY_TLS_FILE = file;
  loadTlsState();
});
afterEach(() => {
  delete process.env.PROXY_TLS_FILE;
});

describe('TLS store', () => {
  it('keeps verified CAs across a restart, mode 600', async () => {
    await addVerifiedCa(A, CA_A);
    loadTlsState();
    expect(verifiedCas([B, A])).toEqual([CA_A]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps fallback pins and announces a change once', async () => {
    const seen: string[] = [];
    const on = (e: { cam: string }) => seen.push(e.cam);
    trustEvents.on('trust', on);
    try {
      await setFallbackPin('cam5', LEAF);
      await setFallbackPin('cam5', LEAF);
      loadTlsState();
      expect(fallbackPin('cam5')).toBe(LEAF);
      await setFallbackPin('cam5', null);
      expect(fallbackPin('cam5')).toBeUndefined();
      expect(seen).toEqual(['cam5', 'cam5']);
    } finally {
      trustEvents.off('trust', on);
    }
  });

  it('drops a CA whose PEM doesn’t match its fingerprint (a hand-edited file)', () => {
    writeFileSync(file, JSON.stringify({ cas: { [A]: CA_B, [B]: CA_B }, pins: { cam5: 'nope', cam6: LEAF } }));
    loadTlsState();
    expect(verifiedCas([A, B])).toEqual([CA_B]);
    expect(fallbackPin('cam5')).toBeUndefined();
    expect(fallbackPin('cam6')).toBe(LEAF);
  });

  it('starts empty from a missing or corrupt file', () => {
    writeFileSync(file, '{not json');
    loadTlsState();
    expect(verifiedCas([A])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tlsStore.test.ts`
Expected: FAIL: `Cannot find module '../server/tls/store'`.

- [ ] **Step 3: Implement**

```ts
// server/tls/store.ts
import { EventEmitter } from 'events';
import { readFileSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { logger } from '../logger';
import { certFingerprint, normalizeFingerprint } from './fingerprint';

// What cams keeps of its cam-proxies' TLS (cam-proxy spec 2026-10-05
// §10.1.4, §12.3): every site CA it verified against a pin (fingerprint →
// PEM), and the fallback leaf pins its proxies reported (cams camera id →
// fingerprint). Kept on disk, so a camera stays reachable while its proxy is
// away: PROXY_TLS_FILE, else proxy-tls.json next to the preferences (the
// cams-data volume), else the temp folder. Nothing in it is secret.
const file = () =>
  process.env.PROXY_TLS_FILE ||
  (process.env.PREFS_FILE ? join(dirname(process.env.PREFS_FILE), 'proxy-tls.json') : join(tmpdir(), 'cams-proxy-tls.json'));

let cas = new Map<string, string>();
let pins = new Map<string, string>();
let writing: Promise<unknown> = Promise.resolve();

// 'trust' {cam}: a camera's trust changed (a CA verified, a pin set or
// cleared): its direct client is built again.
export const trustEvents = new EventEmitter();
trustEvents.setMaxListeners(0);

const fingerprintOf = (pem: string): string | null => {
  try {
    return certFingerprint(pem);
  } catch {
    return null;
  }
};

export function loadTlsState(): void {
  cas = new Map();
  pins = new Map();
  let text: string;
  try {
    text = readFileSync(file(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ message: (err as Error).message }, 'proxy_tls_state_unreadable');
    return;
  }
  try {
    const parsed = JSON.parse(text) as { cas?: Record<string, unknown>; pins?: Record<string, unknown> };
    // Re-checked: a CA is kept only under its own fingerprint.
    for (const [fp, pem] of Object.entries(parsed.cas ?? {})) if (typeof pem === 'string' && fingerprintOf(pem) === fp) cas.set(fp, pem);
    for (const [cam, fp] of Object.entries(parsed.pins ?? {})) {
      const n = normalizeFingerprint(fp);
      if (n) pins.set(cam, n);
    }
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'proxy_tls_state_corrupt');
  }
}

// Serialized, atomic (temp file, then rename), mode 600. A failed write is
// logged: the state in memory still holds until the next start.
function save(): Promise<void> {
  const run = writing.then(async () => {
    const target = file();
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ cas: Object.fromEntries(cas), pins: Object.fromEntries(pins) }), { mode: 0o600 });
    await fs.rename(tmp, target).catch(async (err: unknown) => {
      await fs.rm(tmp, { force: true });
      throw err;
    });
  });
  writing = run.catch((err: unknown) => logger.warn({ message: (err as Error).message }, 'proxy_tls_state_unwritten'));
  return writing as Promise<void>;
}

export const verifiedCas = (want: string[]): string[] => want.flatMap((fp) => (cas.has(fp) ? [cas.get(fp)!] : []));

export async function addVerifiedCa(fingerprint: string, pem: string): Promise<void> {
  if (cas.get(fingerprint) === pem) return;
  cas.set(fingerprint, pem);
  await save();
}

export const fallbackPin = (cam: string): string | undefined => pins.get(cam);

export async function setFallbackPin(cam: string, fingerprint: string | null): Promise<void> {
  if ((pins.get(cam) ?? null) === fingerprint) return;
  if (fingerprint) pins.set(cam, fingerprint);
  else pins.delete(cam);
  await save();
  trustEvents.emit('trust', { cam });
}
```

In `server/server.ts`: `import { loadTlsState } from './tls/store';` and `loadTlsState();` right after `loadProxyState();`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tlsStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tls/store.ts server/server.ts test/tlsStore.test.ts
git commit -m "feat: keep verified site CAs and fallback pins across restarts"
```

---

### Task 3: cams → proxy over HTTPS, trusting only the pinned CA

**Files:**
- Create: `server/tls/groupCa.ts`
- Modify: `server/proxy/client.ts` (`ProxyClient` options and `open()`, `proxyClientFor`, `groupTrustOptions`), `server/proxy/stream.ts` (`startProxyStreams`), `server/routes/proxy.ts` (the login-link client)
- Test: `test/proxyTls.test.ts` (new)

**Interfaces:**
- Consumes: `ProxyGroup.pins/tlsServername` (Task 1), store (Task 2), `fetchPinnedCa`, `siteCaDispatcher`, `fetchWith`, `SiteCaError` (P3 Task 6).
- Produces:
  - `ensureGroupCa(g: ProxyGroup, o?: { force?: boolean }): Promise<string[]>` (verified PEMs; fetched when none is cached or `force`; one fetch per group at a time; emits `trust` for the members when the set changes)
  - `groupDispatcher(g: ProxyGroup): Promise<Dispatcher | undefined>` (undefined for a group without pins or with an `http:` URL)
  - `groupTlsFailed(g: ProxyGroup): void` (the next `groupDispatcher` fetches the CA again)
  - `ProxyClient` options `{ timeoutMs?: number; dispatcher?: () => Promise<Dispatcher | undefined>; onTlsError?: () => void }`
  - `groupTrustOptions(id: string): Pick<ProxyClientOptions, 'dispatcher' | 'onTlsError'>` (empty for a camera without a pinned proxy); `type ProxyClientOptions` exported

- [ ] **Step 1: Write the failing test**

```ts
// test/proxyTls.test.ts
// cams → a site-CA cam-proxy over HTTPS (cam-proxy spec 2026-10-05 §10.1.4,
// §12.3): the CA from /tls/ca.pem against the pin, then that CA only, the
// proxy's certificate checked against its TLS name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras, type CameraConfig } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { proxyHub, proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { loadProxyState } from '../server/proxyState';
import { SESSION_COOKIE, signSession } from '../server/session';
import { certFingerprint } from '../server/tls/fingerprint';
import { loadTlsState, verifiedCas } from '../server/tls/store';
import { FAKE_ADMIN_TOKEN, FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const A = certFingerprint(fx('ca-a.pem')), B = certFingerprint(fx('ca-b.pem'));
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const OPTS = { backoffMinMs: 50, backoffMaxMs: 300, healthyMs: 200 };
let fake: FakeProxy | undefined;

async function siteProxy(leaf: 'proxy-a' | 'proxy-b' = 'proxy-a', port?: number): Promise<FakeProxy> {
  fake = await startFakeProxy({ port, tls: { key: fx(`${leaf}.key`), cert: fx(`${leaf}.pem`) } });
  fake.caPem = fx(leaf === 'proxy-a' ? 'ca-a.pem' : 'ca-b.pem');
  return fake;
}
const cams = (url: string, pins: string[], more: Partial<NonNullable<CameraConfig['proxy']>> = {}): void => {
  setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url, token: FAKE_TOKEN, camera: 'cam1', tlsServername: 'proxy.test.internal', caFingerprint: pins, ...more } }]);
  resetProxyClients();
};
const paths = () => fake!.requests.map((r) => r.path);

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cams-ptls-'));
  process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
  process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
  loadTlsState();
  loadProxyState();
});
afterEach(async () => {
  stopProxyStreams();
  await fake?.stop();
  fake = undefined;
  setCameras([]);
  delete process.env.PROXY_TLS_FILE;
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

describe('a site-CA proxy over HTTPS', () => {
  it('fetches the CA once, then streams over TLS that trusts only it', async () => {
    const f = await siteProxy();
    cams(f.url, [A]);
    const got: { cam: string }[] = [];
    const on = (m: { cam: string }) => got.push(m);
    proxyHub.on('message', on);
    try {
      startProxyStreams(OPTS);
      await expect.poll(() => proxyStates()[0]?.up).toBe(true);
      f.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
      await expect.poll(() => got.length).toBe(1);
      expect(paths().filter((p) => p === '/tls/ca.pem')).toHaveLength(1);
      expect(verifiedCas([A])).toEqual([fx('ca-a.pem')]);
    } finally {
      proxyHub.off('message', on);
    }
  });

  it('never sends the token past a wrong pin', async () => {
    const f = await siteProxy();
    cams(f.url, [B]);
    startProxyStreams(OPTS);
    await new Promise((r) => setTimeout(r, 400));
    expect(proxyStates()[0]?.up).toBe(false);
    expect(new Set(paths())).toEqual(new Set(['/tls/ca.pem']));
    expect(f.requests.every((r) => r.auth === undefined)).toBe(true);
  });

  it('refuses the proxy’s certificate under another name', async () => {
    const f = await siteProxy();
    cams(f.url, [A], { tlsServername: 'cam3.test.internal' });
    startProxyStreams(OPTS);
    await new Promise((r) => setTimeout(r, 400));
    expect(proxyStates()[0]?.up).toBe(false);
    expect(paths().includes('/api/stream')).toBe(false); // the TLS handshake failed before any request
  });

  it('follows a CA rotation within the pinned list', async () => {
    const f = await siteProxy('proxy-a');
    const port = Number(new URL(f.url).port);
    cams(f.url, [A, B]);
    startProxyStreams(OPTS);
    await expect.poll(() => proxyStates()[0]?.up).toBe(true);
    await f.stop();
    await siteProxy('proxy-b', port); // same address, new CA
    await expect.poll(() => proxyStates()[0]?.up, { timeout: 5000 }).toBe(true);
    expect(verifiedCas([A, B])).toHaveLength(2);
  });

  it('answers proxy info and mints a login link over the pinned channel', async () => {
    const f = await siteProxy();
    f.publicUrl = 'https://192.168.1.230:8443';
    setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: f.url, token: FAKE_TOKEN, adminToken: FAKE_ADMIN_TOKEN, camera: 'cam1', tlsServername: 'proxy.test.internal', caFingerprint: [A] } }]);
    resetProxyClients();
    const info = await request(createApp()).get('/api/cameras/den/proxy/info').set('Cookie', auth);
    expect(info.body).toEqual({ reachable: true, webUrl: 'https://192.168.1.230:8443' });
    const link = await request(createApp()).post('/api/cameras/den/proxy/login-link').set('Cookie', auth).set('Origin', 'http://127.0.0.1').send();
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/^https:\/\/192\.168\.1\.230:8443\/control\/login-link\?code=fake-code-1$/);
  });

  it('keeps plain http without a pin (the Pi), never asking for /tls/ca.pem', async () => {
    fake = await startFakeProxy();
    setCameras([{ id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } }]);
    resetProxyClients();
    startProxyStreams(OPTS);
    await expect.poll(() => proxyStates()[0]?.up).toBe(true);
    expect(paths().includes('/tls/ca.pem')).toBe(false);
  });
});
```

(The login-link request's `Origin` header: use whatever the same-origin check in `server/middleware` accepts in the existing `test/proxyRoutes.test.ts` login-link test; copy that test's request setup if it differs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxyTls.test.ts`
Expected: FAIL: "fetches the CA once…" never comes up (global fetch refuses the test CA's certificate).

- [ ] **Step 3: Write `groupCa.ts`**

```ts
// server/tls/groupCa.ts
import type { Dispatcher } from 'undici';
import type { ProxyGroup } from '../proxy/groups';
import { fetchPinnedCa, siteCaDispatcher } from './siteCa';
import { addVerifiedCa, trustEvents, verifiedCas } from './store';

// A pinned cam-proxy's site CA at run time (cam-proxy spec 2026-10-05
// §10.1.4): cached once verified, fetched again when the proxy's certificate
// stops verifying (a rotation within the pinned list, §10.7).

const inflight = new Map<string, Promise<string[]>>();
const dispatchers = new Map<string, { cas: string; dispatcher: Dispatcher }>();
const refetch = new Set<string>();

export function ensureGroupCa(g: ProxyGroup, o: { force?: boolean } = {}): Promise<string[]> {
  const pins = g.pins;
  if (!pins) return Promise.resolve([]);
  const cached = verifiedCas(pins);
  if (cached.length && !o.force) return Promise.resolve(cached);
  let p = inflight.get(g.key);
  if (!p) {
    p = fetchPinnedCa(g.url, pins)
      .then(async (ca) => {
        const before = verifiedCas(pins).join('');
        await addVerifiedCa(ca.fingerprint, ca.pem);
        const now = verifiedCas(pins);
        if (now.join('') !== before) for (const cam of g.members) trustEvents.emit('trust', { cam });
        return now;
      })
      .finally(() => inflight.delete(g.key));
    inflight.set(g.key, p);
  }
  return p;
}

// The dispatcher for an https proxy with a pinned site CA; undefined for any
// other proxy (global fetch, as before). Rejects like fetchPinnedCa.
export async function groupDispatcher(g: ProxyGroup): Promise<Dispatcher | undefined> {
  if (!g.pins || !g.url.startsWith('https:')) return undefined;
  const force = refetch.delete(g.key);
  const cas = await ensureGroupCa(g, { force });
  const key = cas.join('');
  const hit = dispatchers.get(g.key);
  if (hit?.cas === key) return hit.dispatcher;
  void hit?.dispatcher.close().catch(() => undefined);
  const dispatcher = siteCaDispatcher(cas, g.tlsServername ?? undefined);
  dispatchers.set(g.key, { cas: key, dispatcher });
  return dispatcher;
}

// The proxy's certificate failed to verify: ask for its CA again next time.
export function groupTlsFailed(g: ProxyGroup): void {
  refetch.add(g.key);
}
```

- [ ] **Step 4: The proxy client over the dispatcher**

In `server/proxy/client.ts`:
- imports: `import type { Dispatcher } from 'undici';`, `import { fetchWith, SiteCaError } from '../tls/siteCa';`, `import { groupDispatcher, groupTlsFailed } from '../tls/groupCa';`
- add

```ts
export interface ProxyClientOptions {
  timeoutMs?: number;
  // A site-CA proxy (spec 2026-10-05 §12.3): the dispatcher that trusts only
  // its pinned CA, and what to do when its certificate stops verifying.
  dispatcher?: () => Promise<Dispatcher | undefined>;
  onTlsError?: () => void;
}

const tlsFailure = (err: unknown): boolean => /CERT|ERR_TLS_|SIGNATURE|UNABLE_TO|ALTNAME/.test(String((err as { cause?: { code?: unknown } }).cause?.code ?? ''));
```

- the constructor's second parameter becomes `private readonly o: ProxyClientOptions = {}`
- in `open()`, right after `init.signal?.throwIfAborted();`:

```ts
    let dispatcher: Dispatcher | undefined;
    try {
      dispatcher = await this.o.dispatcher?.();
    } catch (err) {
      throw new ProxyError('proxy_unreachable', `cam-proxy ${this.host()}: ${err instanceof SiteCaError ? err.message.replace(/^cam-proxy [^:]+: /, '') : 'its site CA is not verified'}`);
    }
```

  the `fetch(` call becomes `fetchWith(dispatcher)(`, and in its `catch (err)` before the `throw new ProxyError('proxy_unreachable', …)` add `if (dispatcher && tlsFailure(err)) this.o.onTlsError?.();`
- `proxyClientFor` builds the client with `new ProxyClient({ url: g.url, token: g.token }, trustOf(g))` where

```ts
const trustOf = (g: ProxyGroup): Pick<ProxyClientOptions, 'dispatcher' | 'onTlsError'> =>
  g.pins ? { dispatcher: () => groupDispatcher(g), onTlsError: () => groupTlsFailed(g) } : {};

// For another client of the same proxy (the admin token's): the same trust.
export function groupTrustOptions(id: string): Pick<ProxyClientOptions, 'dispatcher' | 'onTlsError'> {
  const g = groupOf(id);
  return g ? trustOf(g) : {};
}
```

  (add `type ProxyGroup` to the `./groups` import).

In `server/routes/proxy.ts` the login-link client becomes `new ProxyClient({ url: proxy.url, token: proxy.adminToken }, { timeoutMs: 3000, ...groupTrustOptions(id) })` (import `groupTrustOptions`).

In `server/proxy/stream.ts` `startProxyStreams`, before the `for` loop over groups, fetch every pinned group's CA (an `http://` loopback proxy needs it for its cameras even though its own channel doesn't):

```ts
  for (const g of proxyGroups()) {
    if (g.pins) void ensureGroupCa(g).catch((err: unknown) => logger.warn({ proxy: new URL(g.url).host, message: (err as Error).message }, 'proxy_site_ca_unverified'));
  }
```

with `import { ensureGroupCa } from '../tls/groupCa';`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/proxyTls.test.ts test/proxyGroupStream.test.ts test/proxyStream.test.ts test/proxyRoutes.test.ts test/proxyClient.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add server/tls/groupCa.ts server/proxy/client.ts server/proxy/stream.ts server/routes/proxy.ts test/proxyTls.test.ts
git commit -m "feat: reach a site-CA cam-proxy over HTTPS, trusting only its pinned CA"
```

---

### Task 4: Camera TLS by trust kind, with a leaf pin checked before anything is sent

**Files:**
- Modify: `server/reolink/http.ts` (`CameraTrust`, `CameraTarget.trust`, `tlsOptions`, `pinnedConnection`, `openRequest`), `server/reolink/client.ts` (`isTlsCertError`), `server/proxy/client.ts` (`tlsFailure`)
- Create: `test/helpers/tlsCamera.ts` (a TLS test server that answers like a camera and counts bytes)
- Test: `test/cameraTls.test.ts` (new)

**Interfaces:**
- Consumes: `normalizeFingerprint` (P3 Task 5).
- Produces:
  - `type CameraTrust = { kind: 'public'; servername: string; ca?: string | Buffer } | { kind: 'site-ca'; ca: string[]; servername?: string } | { kind: 'pinned'; fingerprint: string } | { kind: 'none' } | { kind: 'unavailable'; reason: string }`
  - `CameraTarget { protocol; host; tlsServername?: string; trust?: CameraTrust }` (`trust` wins; without it, `tlsServername` → `public`, else `none`: today's behaviour)
  - `trustOf(target: CameraTarget): CameraTrust`
  - `tlsOptions(trust: CameraTrust, timeoutMs: number): https.RequestOptions` (throws an error with `code: 'ERR_TLS_CA_UNVERIFIED'` for `unavailable`)
  - `pinnedConnection(fingerprint: string, timeoutMs: number): NonNullable<https.RequestOptions['createConnection']>` (fails with `code: 'ERR_TLS_CERT_PIN_MISMATCH'`)
  - `startTlsCamera(name: 'cam-a' | 'selfsigned' | 'outside-a'): Promise<{ host: string; received(): number; stop(): Promise<void> }>` (test helper: answers every HTTP request `200 [{"cmd":"x","code":0,"value":{}}]`; `received()` counts decrypted request bytes)

- [ ] **Step 1: Write the helper and the failing test**

```ts
// test/helpers/tlsCamera.ts
// A TLS server with one of the site-CA fixture certificates that answers
// like a camera's API (a fixed JSON reply) and counts the request bytes it
// received after the handshake.
import { readFileSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { join } from 'path';

const fx = (n: string) => readFileSync(join(__dirname, '../fixtures/site-ca', n));

export async function startTlsCamera(name: 'cam-a' | 'selfsigned' | 'outside-a', reply: (cmd: string) => unknown = (cmd) => [{ cmd, code: 0, value: {} }]) {
  let received = 0;
  const server = https.createServer({ key: fx(`${name}.key`), cert: fx(`${name}.pem`) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const cmd = /cmd=([A-Za-z]+)/.exec(req.url ?? '')?.[1] ?? 'x';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply(cmd)));
    });
  });
  server.on('secureConnection', (s) => s.on('data', (d: Buffer) => (received += d.length)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    received: () => received,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

```ts
// test/cameraTls.test.ts
// Camera TLS by trust (cam-proxy spec 2026-10-05 §12.3): a site CA with the
// camera's .internal name, a leaf pin for a camera that refused the import,
// today's public-CA name check, or nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { openRequest, readBody, type CameraTrust } from '../server/reolink/http';
import { certFingerprint } from '../server/tls/fingerprint';
import { startTlsCamera } from './helpers/tlsCamera';

const pem = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', `${n}.pem`), 'utf8');
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((s) => s()));
});
async function cam(name: 'cam-a' | 'selfsigned' | 'outside-a') {
  const c = await startTlsCamera(name);
  stops.push(c.stop);
  return c;
}
const call = (host: string, trust: CameraTrust) =>
  openRequest({ protocol: 'https', host, trust }, '/cgi-bin/api.cgi?cmd=GetDevInfo', { method: 'POST', body: '[{"cmd":"GetDevInfo"}]', timeoutMs: 2000 }).then(
    async (res) => `${res.statusCode} ${(await readBody(res)).length > 0}`,
    (err: { code?: string }) => `error ${err.code}`,
  );

describe('camera TLS by trust', () => {
  it('site CA: trusts the camera’s leaf by the CA, by name or by address', async () => {
    const c = await cam('cam-a');
    expect(await call(c.host, { kind: 'site-ca', ca: [pem('ca-a')], servername: 'cam3.test.internal' })).toBe('200 true');
    expect(await call(c.host, { kind: 'site-ca', ca: [pem('ca-a')] })).toBe('200 true'); // IP SAN 127.0.0.1
  });

  it('site CA: refuses another CA, another name, and a leaf outside the CA’s constraints', async () => {
    const c = await cam('cam-a');
    expect(await call(c.host, { kind: 'site-ca', ca: [pem('ca-b')], servername: 'cam3.test.internal' })).toMatch(/^error /);
    expect(await call(c.host, { kind: 'site-ca', ca: [pem('ca-a')], servername: 'cam4.test.internal' })).toBe('error ERR_TLS_CERT_ALTNAME_INVALID');
    const evil = await cam('outside-a');
    expect(await call(evil.host, { kind: 'site-ca', ca: [pem('ca-a')], servername: 'evil.example' })).toMatch(/^error /);
  });

  it('pinned: accepts the factory certificate with that fingerprint', async () => {
    const c = await cam('selfsigned');
    expect(await call(c.host, { kind: 'pinned', fingerprint: certFingerprint(pem('selfsigned')) })).toBe('200 true');
  });

  it('pinned: sends nothing when the pin doesn’t match', async () => {
    const c = await cam('selfsigned');
    expect(await call(c.host, { kind: 'pinned', fingerprint: 'ab'.repeat(32) })).toBe('error ERR_TLS_CERT_PIN_MISMATCH');
    await new Promise((r) => setTimeout(r, 50));
    expect(c.received()).toBe(0);
  });

  it('public: today’s name check (a test CA standing in for the public ones)', async () => {
    const c = await cam('cam-a');
    expect(await call(c.host, { kind: 'public', servername: 'cam3.test.internal', ca: pem('ca-a') })).toBe('200 true');
    expect(await call(c.host, { kind: 'public', servername: 'cam3.test.internal' })).toMatch(/^error /);
  });

  it('none: unverified, as today without a tlsServername', async () => {
    expect(await call((await cam('selfsigned')).host, { kind: 'none' })).toBe('200 true');
  });

  it('unavailable: refuses at once, connecting nowhere', async () => {
    const c = await cam('cam-a');
    expect(await call(c.host, { kind: 'unavailable', reason: 'the proxy’s site CA is not verified yet' })).toBe('error ERR_TLS_CA_UNVERIFIED');
    expect(c.received()).toBe(0);
  });

  it('keeps today’s target without a trust: tlsServername means a name check', async () => {
    const c = await cam('selfsigned');
    const res = await openRequest({ protocol: 'https', host: c.host }, '/', { timeoutMs: 2000 });
    expect(res.statusCode).toBe(200);
    res.resume();
    await expect(openRequest({ protocol: 'https', host: c.host, tlsServername: 'cam1.test.local' }, '/', { timeoutMs: 2000 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cameraTls.test.ts`
Expected: FAIL: TypeScript/vitest error on `trust` / `CameraTrust` (not exported), or the site-CA cases failing.

- [ ] **Step 3: Implement**

In `server/reolink/http.ts`:

```ts
import { connect as tlsConnect } from 'node:tls';
import { normalizeFingerprint } from '../tls/fingerprint';

// How a camera's certificate is checked (cam-proxy spec 2026-10-05 §12.3):
//   public:      today's check against public CAs and the camera's
//                tlsServername (cam1's Let's Encrypt certificate);
//                `ca` is a test seam only
//   site-ca:     only the pinned site CA(s) of the camera's proxy, against
//                its .internal name, or its address (the leaf's IP SAN)
//   pinned:      the SHA-256 of the leaf and nothing else: a camera that
//                refused the import (its factory certificate)
//   none:        unverified (today's https camera without a tlsServername)
//   unavailable: a site-CA camera before its CA was ever verified: refused
export type CameraTrust =
  | { kind: 'public'; servername: string; ca?: string | Buffer }
  | { kind: 'site-ca'; ca: string[]; servername?: string }
  | { kind: 'pinned'; fingerprint: string }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string };

export interface CameraTarget {
  protocol: 'https' | 'http';
  host: string; // "ip" or "ip:port"
  tlsServername?: string; // without `trust`: a public-CA check against this name
  trust?: CameraTrust;
}

export const trustOf = (t: CameraTarget): CameraTrust => t.trust ?? (t.tlsServername ? { kind: 'public', servername: t.tlsServername } : { kind: 'none' });

const tlsError = (code: string, message: string) => Object.assign(new Error(message), { code });

// The leaf pin is checked on the socket at secureConnect, before the request
// is written: Node skips checkServerIdentity when the chain doesn't verify
// (a self-signed certificate), so it can't carry this check.
export function pinnedConnection(fingerprint: string, timeoutMs: number): NonNullable<https.RequestOptions['createConnection']> {
  return (opts, oncreate) => {
    const host = String(opts.hostname ?? opts.host ?? '').replace(/^\[(.*)\]$/, '$1');
    const socket = tlsConnect({ host, port: Number(opts.port ?? 443), rejectUnauthorized: false });
    socket.setTimeout(timeoutMs, () => socket.destroy(new TimeoutError()));
    const onError = (err: Error) => oncreate(err, socket);
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.off('error', onError);
      socket.setTimeout(0);
      if (normalizeFingerprint(socket.getPeerCertificate().fingerprint256) === fingerprint) return oncreate(null, socket);
      socket.destroy();
      oncreate(tlsError('ERR_TLS_CERT_PIN_MISMATCH', 'camera certificate does not match its pinned fingerprint'), socket);
    });
    return undefined;
  };
}

export function tlsOptions(trust: CameraTrust, timeoutMs: number): https.RequestOptions {
  switch (trust.kind) {
    case 'public':
      return { servername: trust.servername, rejectUnauthorized: true, ...(trust.ca && { ca: trust.ca }) };
    case 'site-ca':
      return { ca: trust.ca, rejectUnauthorized: true, ...(trust.servername && { servername: trust.servername }) };
    case 'pinned':
      return { createConnection: pinnedConnection(trust.fingerprint, timeoutMs), agent: undefined };
    case 'none':
      return { rejectUnauthorized: false };
    case 'unavailable':
      throw tlsError('ERR_TLS_CA_UNVERIFIED', trust.reason);
  }
}
```

and in `openRequest` replace the `const tls = …` block with:

```ts
  let tls: https.RequestOptions = {};
  if (target.protocol === 'https') {
    try {
      tls = tlsOptions(trustOf(target), opts.timeoutMs);
    } catch (err) {
      return Promise.reject(err);
    }
  }
```

(`TimeoutError` is defined above in the same file; `https` is already imported.)

In `server/reolink/client.ts` `isTlsCertError`, add the name-constraint failure (OpenSSL's `PERMITTED_SUBTREE_VIOLATION` / `EXCLUDED_SUBTREE_VIOLATION` contain neither "CERT" nor "SIGNATURE"): the return becomes `return code.startsWith('ERR_TLS_') || code.includes('CERT') || code.includes('SIGNATURE') || code.includes('SUBTREE');`, and in `server/proxy/client.ts`'s `tlsFailure` regex add `|SUBTREE`. Add to `test/cameraTls.test.ts`:

```ts
import { classifyNetworkError } from '../server/reolink/client';

it('reports a name-constraint failure as a certificate error, not offline', () => {
  expect(classifyNetworkError(Object.assign(new Error('x'), { code: 'PERMITTED_SUBTREE_VIOLATION' })).code).toBe('camera_error');
  expect(classifyNetworkError(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_PIN_MISMATCH' })).code).toBe('camera_error');
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cameraTls.test.ts test/reolinkClient.test.ts test/cameraCertificate.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/reolink/http.ts server/reolink/client.ts server/proxy/client.ts test/helpers/tlsCamera.ts test/cameraTls.test.ts
git commit -m "feat: camera TLS by trust: site CA, leaf pin before sending, public, none"
```

---

### Task 5: Each camera's trust, in the direct client

**Files:**
- Create: `server/tls/cameraTrust.ts` (`cameraTrust`)
- Modify: `server/reolink/client.ts` (constructor `opts.trust`, `cameraCertificate()`), `server/reolink/clients.ts` (trust, rebuild on `trustEvents`)
- Test: `test/cameraTrust.test.ts` (new)

**Interfaces:**
- Consumes: `CameraTrust`, `trustOf` (Task 4); `groupOf` with `pins` (Task 1); `verifiedCas`, `fallbackPin`, `trustEvents` (Task 2); `ensureGroupCa` (Task 3).
- Produces:
  - `cameraTrust(cam: CameraConfig): CameraTrust`
  - `ReolinkClient` options `{ …; trust?: CameraTrust }` (with it, `tlsCa` is ignored)
  - `getClient(id)` builds with `cameraTrust`; a `trust` event drops that camera's client

- [ ] **Step 1: Write the failing test**

```ts
// test/cameraTrust.test.ts
// Which trust a camera gets (cam-proxy spec 2026-10-05 §12.3), and the
// direct client using it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCamera, setCameras, type CameraConfig } from '../server/cameraRegistry';
import { groupOf } from '../server/proxy/groups';
import { getClient, resetClients } from '../server/reolink/clients';
import { cameraTrust } from '../server/tls/cameraTrust';
import { certFingerprint } from '../server/tls/fingerprint';
import { ensureGroupCa } from '../server/tls/groupCa';
import { addVerifiedCa, loadTlsState, setFallbackPin } from '../server/tls/store';
import { startTlsCamera } from './helpers/tlsCamera';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const pem = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', `${n}.pem`), 'utf8');
const CA_A = pem('ca-a'), A = certFingerprint(CA_A);
const T = FAKE_TOKEN;
const stops: (() => Promise<unknown>)[] = [];
const reply = (cmd: string) => (cmd === 'Login' ? [{ cmd, code: 0, value: { Token: { name: 'tok', leaseTime: 3600 } } }] : [{ cmd, code: 0, value: { DevInfo: { model: 'RLC-1224A', firmVer: 'v3', name: 'Gate' } } }]);

beforeEach(() => {
  process.env.PROXY_TLS_FILE = join(mkdtempSync(join(tmpdir(), 'cams-ctrust-')), 'proxy-tls.json');
  loadTlsState();
  resetClients();
});
afterEach(async () => {
  await Promise.all(stops.splice(0).map((s) => s()));
  setCameras([]);
  resetClients();
  delete process.env.PROXY_TLS_FILE;
});

const site = (id: string, host: string, url = 'https://192.168.1.230:8443', more: Partial<CameraConfig> = {}): CameraConfig => ({
  id, name: id, host, protocol: 'https', tlsServername: 'cam3.test.internal', user: 'cams', password: 'pw',
  proxy: { url, token: T, camera: id, tlsServername: 'proxy.test.internal', caFingerprint: [A] }, ...more,
});

describe('cameraTrust', () => {
  it('a site-CA camera: unavailable until the CA is verified, then the CA and its name', async () => {
    setCameras([site('cam3', '192.168.60.13')]);
    expect(cameraTrust(getCamera('cam3')!)).toEqual({ kind: 'unavailable', reason: 'the proxy’s site CA is not verified yet' });
    await addVerifiedCa(A, CA_A);
    expect(cameraTrust(getCamera('cam3')!)).toEqual({ kind: 'site-ca', ca: [CA_A], servername: 'cam3.test.internal' });
  });

  it('a fallback pin wins over the CA', async () => {
    setCameras([site('cam3', '192.168.60.13')]);
    await addVerifiedCa(A, CA_A);
    await setFallbackPin('cam3', 'cd'.repeat(32));
    expect(cameraTrust(getCamera('cam3')!)).toEqual({ kind: 'pinned', fingerprint: 'cd'.repeat(32) });
  });

  it('keeps the Pi’s Let’s Encrypt path', () => {
    setCameras([{ id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'cams', password: 'pw', proxy: { url: 'http://127.0.0.1:8480', token: T } }]);
    expect(cameraTrust(getCamera('cam1')!)).toEqual({ kind: 'public', servername: 'cam1.skylar.technology' });
    expect(groupOf('cam1')?.pins).toBeNull();
  });

  it('keeps http and unverified https as they are', () => {
    setCameras([
      { id: 'a', name: 'a', host: '127.0.0.1:1', protocol: 'http', user: 'u', password: 'p' },
      { id: 'b', name: 'b', host: '127.0.0.1:1', protocol: 'https', user: 'u', password: 'p' },
    ]);
    expect([cameraTrust(getCamera('a')!), cameraTrust(getCamera('b')!)]).toEqual([{ kind: 'none' }, { kind: 'none' }]);
  });
});

describe('the direct client with a site CA', () => {
  it('talks to a camera whose leaf the site CA signed', async () => {
    const c = await startTlsCamera('cam-a', reply);
    stops.push(c.stop);
    setCameras([site('cam3', c.host)]);
    await addVerifiedCa(A, CA_A);
    expect((await getClient('cam3')!.status()).model).toBe('RLC-1224A');
    expect((await getClient('cam3')!.cameraCertificate())?.subject).toBe('cam3.test.internal');
  });

  it('uses the cached CA after a restart while the proxy is away', async () => {
    const c = await startTlsCamera('cam-a', reply);
    stops.push(c.stop);
    await addVerifiedCa(A, CA_A);
    loadTlsState(); // a restart; the proxy URL below answers nothing
    setCameras([site('cam3', c.host, 'https://127.0.0.1:9')]);
    expect((await getClient('cam3')!.status()).model).toBe('RLC-1224A');
  });

  it('builds the client again once the CA is verified', async () => {
    const c = await startTlsCamera('cam-a', reply);
    stops.push(c.stop);
    const f: FakeProxy = await startFakeProxy({ tls: { key: readFileSync(join(__dirname, 'fixtures/site-ca/proxy-a.key')), cert: pem('proxy-a') } });
    f.caPem = CA_A;
    stops.push(() => f.stop());
    setCameras([site('cam3', c.host, f.url)]);
    await expect(getClient('cam3')!.status()).rejects.toMatchObject({ code: 'camera_error' });
    await ensureGroupCa(groupOf('cam3')!);
    expect((await getClient('cam3')!.status()).model).toBe('RLC-1224A');
  });

  it('reads a pinned factory certificate, and nothing for another', async () => {
    const c = await startTlsCamera('selfsigned', reply);
    stops.push(c.stop);
    setCameras([site('cam5', c.host)]);
    await setFallbackPin('cam5', certFingerprint(pem('selfsigned')));
    expect((await getClient('cam5')!.cameraCertificate())?.subject).toBe('CERTIFICATE');
    await setFallbackPin('cam5', 'ab'.repeat(32));
    expect(await getClient('cam5')!.cameraCertificate()).toBeNull();
    await expect(getClient('cam5')!.status()).rejects.toMatchObject({ code: 'camera_error' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cameraTrust.test.ts`
Expected: FAIL: `Cannot find module '../server/tls/cameraTrust'`.

- [ ] **Step 3: Implement `cameraTrust`**

```ts
// server/tls/cameraTrust.ts
import type { CameraConfig } from '../cameraRegistry';
import { groupOf } from '../proxy/groups';
import type { CameraTrust } from '../reolink/http';
import { fallbackPin, verifiedCas } from './store';

// How cams checks a camera's certificate (cam-proxy spec 2026-10-05 §12.3).
// A camera of a pinned proxy: its fallback leaf pin when the proxy reported
// one, else the proxy's verified site CA(s) only; any other camera: today's
// rule (tlsServername: public CAs; none: unverified). Config-based: the
// Settings switch for the proxy doesn't change it.
export function cameraTrust(cam: CameraConfig): CameraTrust {
  if (cam.protocol !== 'https') return { kind: 'none' };
  const pins = groupOf(cam.id)?.pins;
  if (pins) {
    const pin = fallbackPin(cam.id);
    if (pin) return { kind: 'pinned', fingerprint: pin };
    const ca = verifiedCas(pins);
    if (!ca.length) return { kind: 'unavailable', reason: 'the proxy’s site CA is not verified yet' };
    return cam.tlsServername ? { kind: 'site-ca', ca, servername: cam.tlsServername } : { kind: 'site-ca', ca };
  }
  return cam.tlsServername ? { kind: 'public', servername: cam.tlsServername } : { kind: 'none' };
}
```

- [ ] **Step 4: The client and the client cache**

In `server/reolink/client.ts`:
- import `type CameraTrust, trustOf` from `./http`
- constructor options type gains `trust?: CameraTrust`; the target becomes

```ts
    this.target = {
      protocol: cam.protocol,
      host: cam.host,
      trust: opts.trust ?? (cam.tlsServername ? { kind: 'public', servername: cam.tlsServername, ...(opts.tlsCa && { ca: opts.tlsCa }) } : { kind: 'none' }),
    };
    if (cam.protocol === 'https' && trustOf(this.target).kind === 'none') {
      logger.warn({ cameraId: cam.id }, 'camera TLS certificate is not verified (no tlsServername configured)');
    }
```

- `cameraCertificate()` (`server/reolink/client.ts:208-245`): right after `const host = hostname.replace(…);` (before `return new Promise(…)`) add

```ts
    const trust = trustOf(this.target);
    if (trust.kind === 'unavailable') return null;
    const base = { host, port: port ?? 443 };
    const options =
      trust.kind === 'site-ca' ? { ...base, ca: trust.ca, ...(trust.servername && { servername: trust.servername }) }
      : trust.kind === 'pinned' ? { ...base, rejectUnauthorized: false }
      : trust.kind === 'public' ? { ...base, servername: trust.servername, ca: trust.ca }
      : { ...base, servername: host, ca: this.opts.tlsCa }; // none: as today, verified against the address
```

  replace the `tlsConnect({ host, port: port ?? 443, servername: this.cam.tlsServername ?? host, ca: this.opts.tlsCa }, () => {` line with `tlsConnect(options, () => {`, and right after `const c = socket.getPeerCertificate();` add

```ts
        if (trust.kind === 'pinned' && normalizeFingerprint(c?.fingerprint256) !== trust.fingerprint) return finish(null);
```

  (`import { normalizeFingerprint } from '../tls/fingerprint';`). Update the comment above the method: "verified like every other request to this camera (its trust: public name, site CA or leaf pin)".

In `server/reolink/clients.ts`:

```ts
import { cameraTrust } from '../tls/cameraTrust';
import { trustEvents } from '../tls/store';
…
trustEvents.on('trust', ({ cam }: { cam: string }) => clients.delete(cam));
…
  const client = new ReolinkClient(hostFromProxy(cam) ? { ...cam, host: cameraHost(id) ?? '' } : cam, { trust: cameraTrust(cam) });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cameraTrust.test.ts test/cameraTls.test.ts test/cameraCertificate.test.ts test/reolinkClient.test.ts test/cameraAddress.test.ts test/cameraRoutes.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add server/tls/cameraTrust.ts server/reolink/client.ts server/reolink/clients.ts test/cameraTrust.test.ts
git commit -m "feat: verify each camera against its proxy's site CA or its leaf pin"
```

---

### Task 6: Fallback pins from the proxy's camera list

**Files:**
- Modify: `server/tls/cameraTrust.ts` (`applyProxyTls`), `server/proxy/names.ts` (apply the `tls` block; 15-minute refresh)
- Test: `test/fallbackPin.test.ts` (new)

**Interfaces:**
- Consumes: `readProxyList`/`entryOf` (P3 Task 4), `setFallbackPin` (Task 2), `groupOf().pins`.
- Produces:
  - `applyProxyTls(id: string, tls: unknown): Promise<void>` (only for a camera of a pinned group: `mode "pinned"` + valid fingerprint → pin; `mode "site-ca"` → clear; anything else → unchanged)
  - `setListRefreshMs(ms?: number): void` in `names.ts` (tests; default 15 min)

- [ ] **Step 1: Write the failing test**

```ts
// test/fallbackPin.test.ts
// A camera that refused the site certificate (cam-proxy spec 2026-10-05
// §10.1.4): its proxy reports the served fingerprint in /api/cameras
// (tls.mode "pinned"), and cams pins it, over the verified channel only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCamera, setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { setListRefreshMs } from '../server/proxy/names';
import { proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { loadProxyState } from '../server/proxyState';
import { cameraTrust } from '../server/tls/cameraTrust';
import { certFingerprint, formatFingerprint } from '../server/tls/fingerprint';
import { fallbackPin, loadTlsState } from '../server/tls/store';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const A = certFingerprint(fx('ca-a.pem')), LEAF = certFingerprint(fx('selfsigned.pem'));
const OPTS = { backoffMinMs: 50, backoffMaxMs: 300, healthyMs: 200 };
let f: FakeProxy;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cams-fpin-'));
  process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
  process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
  loadTlsState();
  loadProxyState();
  f = await startFakeProxy({ tls: { key: fx('proxy-a.key'), cert: fx('proxy-a.pem') } });
  f.caPem = fx('ca-a.pem');
  f.cameraNames.set('cam5', 'Shed');
  f.cameraTls.set('cam5', { mode: 'pinned', servername: null, fingerprint: formatFingerprint(LEAF), notAfter: null, lastPush: { at: 1, outcome: 'refused' } });
  f.cameraTls.set('cam1', { mode: 'site-ca', servername: 'cam3.test.internal', fingerprint: 'ee'.repeat(32), notAfter: 2, lastPush: null });
});
afterEach(async () => {
  stopProxyStreams();
  setListRefreshMs();
  await f.stop();
  setCameras([]);
  delete process.env.PROXY_TLS_FILE;
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

const cams = (pins: string[] | undefined, url = f.url) => {
  const proxy = (camera: string) => ({ url, token: FAKE_TOKEN, camera, ...(pins && { tlsServername: 'proxy.test.internal', caFingerprint: pins }) });
  setCameras([
    { id: 'den', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam3.test.internal', user: 'u', password: 'p', proxy: proxy('cam1') },
    { id: 'shed', name: 'Shed', host: 'from-proxy', protocol: 'https', ...(pins ? {} : { tlsServername: 'x.test.internal' }), user: 'u', password: 'p', proxy: proxy('cam5') },
  ]);
  resetProxyClients();
};

describe('fallback pins', () => {
  it('pins what the proxy reports for a camera that refused the import, and keeps it', async () => {
    cams([A]);
    startProxyStreams(OPTS);
    await expect.poll(() => fallbackPin('shed')).toBe(LEAF);
    expect(cameraTrust(getCamera('shed')!)).toEqual({ kind: 'pinned', fingerprint: LEAF });
    expect(fallbackPin('den')).toBeUndefined();
    loadTlsState(); // a restart
    expect(fallbackPin('shed')).toBe(LEAF);
  });

  it('clears the pin when the proxy reports the camera on the site CA again', async () => {
    cams([A]);
    startProxyStreams(OPTS);
    await expect.poll(() => fallbackPin('shed')).toBe(LEAF);
    stopProxyStreams();
    resetProxyClients(); // a fresh client: the camera list isn't served from the last 2 s
    f.cameraTls.set('cam5', { mode: 'site-ca', servername: 'cam5.test.internal', fingerprint: 'ff'.repeat(32), notAfter: 3, lastPush: { at: 2, outcome: 'ok' } });
    startProxyStreams(OPTS);
    await expect.poll(() => fallbackPin('shed')).toBeUndefined();
  });

  it('re-reads the list while the stream stays up', async () => {
    setListRefreshMs(200);
    f.cameraTls.delete('cam5');
    cams([A]);
    startProxyStreams(OPTS);
    await expect.poll(() => proxyStates().every((s) => s.up)).toBe(true);
    f.cameraTls.set('cam5', { mode: 'pinned', servername: null, fingerprint: LEAF, notAfter: null, lastPush: null });
    await expect.poll(() => fallbackPin('shed'), { timeout: 5000 }).toBe(LEAF); // the list is shared for 2 s, so the first re-read after that sees it
  });

  it('ignores a tls block from a proxy without a pin', async () => {
    const plain = await startFakeProxy();
    plain.cameraNames.set('cam5', 'Shed');
    plain.cameraTls.set('cam5', { mode: 'pinned', fingerprint: LEAF });
    try {
      cams(undefined, plain.url);
      startProxyStreams(OPTS);
      await expect.poll(() => proxyStates().every((s) => s.up)).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(fallbackPin('shed')).toBeUndefined();
    } finally {
      stopProxyStreams();
      await plain.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fallbackPin.test.ts`
Expected: FAIL: `setListRefreshMs` is not exported / the pin never appears.

- [ ] **Step 3: Implement**

Append to `server/tls/cameraTrust.ts`:

```ts
import { normalizeFingerprint } from './fingerprint';
import { setFallbackPin } from './store';

// The `tls` block of the proxy's camera entry (spec §10.4), read over the
// pinned channel: a camera that refused the import is pinned by the
// fingerprint it serves; back on the site CA, the pin goes. Only for a
// proxy with a pinned site CA: anyone else's word isn't taken.
export async function applyProxyTls(id: string, tls: unknown): Promise<void> {
  if (!groupOf(id)?.pins || typeof tls !== 'object' || tls === null) return;
  const t = tls as { mode?: unknown; fingerprint?: unknown };
  if (t.mode === 'pinned') {
    const fp = normalizeFingerprint(t.fingerprint);
    if (fp) await setFallbackPin(id, fp);
  } else if (t.mode === 'site-ca') await setFallbackPin(id, null);
}
```

In `server/proxy/names.ts`:
- `import { applyProxyTls } from '../tls/cameraTrust';`
- in `refreshProxyName`, after `setReportedAddress(id, mine.address);` add `await applyProxyTls(id, mine.tls);`
- the refresh while up:

```ts
// The list is read again while the stream stays up, so a camera replaced
// meanwhile gets its new pin (and name) without a restart.
const REFRESH_MS = 15 * 60_000;
let refreshMs = REFRESH_MS;
const refreshTimers = new Map<string, NodeJS.Timeout>();
export function setListRefreshMs(ms = REFRESH_MS): void {
  refreshMs = ms;
}
```

  and in the `proxyHub.on('state', …)` handler: at the top `clearInterval(refreshTimers.get(s.cam)); refreshTimers.delete(s.cam);`; in the `if (s.up)` branch, before `return void refreshProxyName(s.cam);`:

```ts
    const timer = setInterval(() => void refreshProxyName(s.cam), refreshMs);
    timer.unref();
    refreshTimers.set(s.cam, timer);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fallbackPin.test.ts test/cameraNameRoutes.test.ts test/cameraAddress.test.ts test/proxyCameraList.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/tls/cameraTrust.ts server/proxy/names.ts test/fallbackPin.test.ts
git commit -m "feat: pin a camera's own certificate when its proxy reports the fallback"
```

---

### Task 7: End to end: the generator's pinned output, loaded and used

**Files:**
- Test: `test/siteCaEndToEnd.test.ts` (new)
- Modify (only if the test finds a gap): `server/cameraImport.ts`

**Interfaces:**
- Consumes: `runCamerasConfig` (P3 Task 10), `loadCameras` (Task 1), streams (Task 3), `getClient` (Task 5), `startTlsCamera` (Task 4).
- Produces: nothing new; proves the P3 generator and the P5 runtime agree.

- [ ] **Step 1: Write the test**

```ts
// test/siteCaEndToEnd.test.ts
// The whole site-CA path in one process (cam-proxy spec 2026-10-05 §13.3,
// §12.3): the generator pins the proxy, writes cameras.json, cams loads it,
// streams from the proxy over HTTPS and reaches the camera over its site
// certificate; a second camera on the leaf-pin fallback.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cameraHost, loadCameras, setCameras } from '../server/cameraRegistry';
import { runCamerasConfig } from '../server/cameraImport';
import { resetProxyClients } from '../server/proxy/client';
import { proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { loadProxyState } from '../server/proxyState';
import { getClient, resetClients } from '../server/reolink/clients';
import { certFingerprint, formatFingerprint } from '../server/tls/fingerprint';
import { fallbackPin, loadTlsState } from '../server/tls/store';
import { startTlsCamera } from './helpers/tlsCamera';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const reply = (cmd: string) => (cmd === 'Login' ? [{ cmd, code: 0, value: { Token: { name: 'tok', leaseTime: 3600 } } }] : [{ cmd, code: 0, value: { DevInfo: { model: 'RLC-1224A', firmVer: 'v3' } } }]);
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  stopProxyStreams();
  await Promise.all(stops.splice(0).map((s) => s()));
  setCameras([]);
  resetClients();
  delete process.env.PROXY_TLS_FILE;
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

describe('site CA end to end', () => {
  it('generator → cameras.json → stream over HTTPS → cameras by CA and by pin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-tls-'));
    process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
    process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
    loadTlsState();
    loadProxyState();
    const cam3 = await startTlsCamera('cam-a', reply);
    const cam5 = await startTlsCamera('selfsigned', reply);
    stops.push(cam3.stop, cam5.stop);
    const f: FakeProxy = await startFakeProxy({ tls: { key: fx('proxy-a.key'), cert: fx('proxy-a.pem') } });
    stops.push(() => f.stop());
    f.caPem = fx('ca-a.pem');
    f.cameraNames.clear();
    f.cameraNames.set('cam3', 'Driveway').set('cam5', 'Shed');
    f.cameraAddresses.set('cam3', cam3.host).set('cam5', cam5.host);
    f.cameraTls.set('cam3', { mode: 'site-ca', servername: 'cam3.test.internal', fingerprint: certFingerprint(fx('cam-a.pem')), notAfter: 1, lastPush: null });
    f.cameraTls.set('cam5', { mode: 'pinned', servername: null, fingerprint: formatFingerprint(certFingerprint(fx('selfsigned.pem'))), notAfter: null, lastPush: { at: 1, outcome: 'refused' } });
    writeFileSync(join(dir, 'cameras-config.json'), JSON.stringify({ proxies: [{ url: f.url, tlsServername: 'proxy.test.internal', caFingerprint: formatFingerprint(certFingerprint(fx('ca-a.pem'))), token: FAKE_TOKEN, cameraUser: 'cams', cameraPassword: 'pw', prefix: 'garage-' }] }), { mode: 0o600 });
    const out: string[] = [];
    expect(await runCamerasConfig(['--output', join(dir, 'cameras.json'), '--write'], {}, { out: (l) => out.push(l), err: (l) => out.push(l) })).toBe(0);

    setCameras(loadCameras(join(dir, 'cameras.json')));
    resetProxyClients();
    resetClients();
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 300, healthyMs: 200 });
    await expect.poll(() => proxyStates()).toEqual([{ cam: 'garage-cam3', up: true }, { cam: 'garage-cam5', up: true }]);
    await expect.poll(() => fallbackPin('garage-cam5')).toBe(certFingerprint(fx('selfsigned.pem')));
    await expect.poll(() => [cameraHost('garage-cam3'), cameraHost('garage-cam5')]).toEqual([cam3.host, cam5.host]); // from-proxy addresses
    expect((await getClient('garage-cam3')!.status()).model).toBe('RLC-1224A');
    expect((await getClient('garage-cam5')!.status()).model).toBe('RLC-1224A');
    expect(f.streamConnections()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/siteCaEndToEnd.test.ts`
Expected: PASS. If it fails, the failure names the gap between the generator's output and the runtime (for example a `from-proxy` camera without a name that the registry refuses); fix it in `server/cameraImport.ts` or the registry, add a unit test for that case in `test/cameraImport.test.ts`, and run both files again.

- [ ] **Step 3: Commit**

```bash
git add test/siteCaEndToEnd.test.ts
git commit -m "test: site CA end to end, from the generator to the cameras"
```

(`git add server/cameraImport.ts test/cameraImport.test.ts` too if Step 2 needed a fix.)

---

### Task 8: Livestack multi-camera stack over HTTPS with a pinned site CA

**Precondition:** cam-proxy P5 (site CA, `server.tls.port`, `/tls/ca.pem`, camera cert push) merged to its `origin/main`, and P3 Task 12 done.

**Files:**
- Modify: `scripts/livestack/start-multi-stack.sh` (a `--tls` flag), `scripts/livestack/check-multi.sh` (three TLS checks when the run is `--tls`), `docs/livestack.md`

**Interfaces:**
- Consumes: P3 Task 12's stack; cam-proxy P5's config `tls: {site, cameraCerts}`, `server.tls.port`.
- Produces: with `--tls`: cam-proxy HTTPS on 19483 (site `livestack`), cam-sims reached by cams over `https` (ports 19444-19446), cams's `cameras.json` from the generator with `caFingerprint` and `tlsServername: "proxy.livestack.internal"`.

- [ ] **Step 1: The `--tls` variant**

In `start-multi-stack.sh`:
- parse `TLS=0; [ "${1:-}" = --tls ] && TLS=1`; `runenv_put TLS "$TLS"`;
- with `TLS=1`, the proxy config gains `tls: {site: "livestack", cameraCerts: true}` and `server.tls: {port: 19483}`, and each camera `protocol: "https"`, `host: "127.0.0.1:1944N"` (its https port);
- after `wait_http …/health`, wait until every camera's certificate is pushed: poll `GET http://127.0.0.1:19482/api/cameras` (client token header file) until every `.tls.mode` is `site-ca` (timeout 180 s; `die` naming the camera otherwise);
- the CA pin: `FP="$(curl -fsS http://127.0.0.1:19482/tls/ca.pem | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2)"` (a local test stack: the pin is read from the proxy itself, which is fine only here; the comment says so);
- the generator input then has `url: "https://127.0.0.1:19483"`, `tlsServername: "proxy.livestack.internal"`, `caFingerprint: $FP`, and no `protocol`.

In `check-multi.sh`, when `TLS=1` in run.env, add:
- 7. cams reaches the proxy over HTTPS: `GET $CAMS/api/cameras/sima/proxy/info` → `.reachable == true`;
- 8. cams reaches each camera directly through the site CA: `GET $CAMS/api/cameras/<id>/status` → 200 for sima, simb, simc;
- 9. the camera certificate shown in Settings is the site leaf: `GET $CAMS/api/cameras/sima/settings` (or whichever route returns `cameraCertificate()`'s result; find it with `grep -rn "cameraCertificate()" server/routes`) → its issuer is `cam-proxy site CA livestack`.

`docs/livestack.md`: the `--tls` flag, what it checks, and that the pin is read from the proxy only because this is a local test.

- [ ] **Step 2: Run it**

Run: `scripts/livestack/start-multi-stack.sh --tls && scripts/livestack/check-multi.sh; scripts/livestack/stop-stack.sh`
Expected: all 9 checks PASS, exit 0; everything on 127.0.0.1.

- [ ] **Step 3: Commit**

```bash
git add scripts/livestack/start-multi-stack.sh scripts/livestack/check-multi.sh docs/livestack.md
git commit -m "test(livestack): the multi-camera stack over HTTPS with a pinned site CA"
```

---

### Task 9: Docs, CHANGELOG and the full gate

**Files:**
- Modify: `README.md` (§ Cameras table, § Security), `CHANGELOG.md`, `docs/pi-demo.md`

- [ ] **Step 1: README**

§ Cameras: in the `host` row, "(it needs `protocol` `https` and a `tlsServername`, …)" becomes "(it needs `protocol` `https` and a `tlsServername`, or a proxy `caFingerprint`, …)". In the `tlsServername` row add: "With a proxy `caFingerprint`, the name on the camera's site certificate (`<camId>.<site>.internal`), checked against that CA only." In the `proxy` row add: "`caFingerprint` (one SHA-256 fingerprint, or a list during a CA rotation) pins the proxy's site CA (cam-proxy spec 2026-10-05 §10): cams fetches `/tls/ca.pem`, accepts it only with that fingerprint, keeps it in `proxy-tls.json` next to the proxy state, and then trusts only it for the proxy's `https` URL (checked against `tlsServername`, `proxy.<site>.internal`) and for every camera of that proxy. A camera that refused the site certificate is pinned by the fingerprint its proxy reports. `http` with a pin only on the proxy's own host (127.0.0.1, ::1, localhost). Every entry of one proxy has the same `caFingerprint` and `tlsServername`."

§ Security: add "**Cameras behind a site-CA cam-proxy:** the pinned CA vouches for the camera's address, so a camera's `from-proxy` address is as trustworthy as that proxy host (which already holds an admin login on its cameras); the CA's name constraints keep it from vouching for any other host (cam-proxy spec 2026-10-05 §10.2)."

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]`:

```markdown
### Added
- A cam-proxy with a site CA is pinned by its CA fingerprint (`caFingerprint`): cams reaches it over HTTPS and verifies its cameras against that CA, or against the camera's own certificate when the proxy reports it couldn't install one.
```

- [ ] **Step 3: Pi note**

`docs/pi-demo.md`: "The Pi has no site CA (cam-proxy spec 2026-10-05 §11): its `cameras.json` has no `caFingerprint`, the proxy stays at `http://127.0.0.1:8480`, and cam1 keeps its Let's Encrypt certificate checked against `cam1.skylar.technology`."

- [ ] **Step 4: The full gate**

Run: `npm test && npm run build && npm run check && npm run lint:types`
Expected: all pass, exit 0. (e2e runs in CI on the PR.)

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/pi-demo.md
git commit -m "docs: pinning a cam-proxy's site CA"
```
