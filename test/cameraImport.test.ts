// test/cameraImport.test.ts
// The cameras.json generator's logic (cam-proxy spec 2026-10-05 §13.3;
// scripts/cameras-config.ts is its command line).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCameras, diffCameras, ImportError, parseImportInput, readProxyCameras, type ImportProxy, type ProxyCamera } from '../server/cameraImport';
import { certFingerprint } from '../server/tls/fingerprint';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

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
    writeFileSync(join(dir, 'token.txt'), `${T}\n`, { mode: 0o600 });
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

  it('refuses a secret file others can read (review #5)', () => {
    writeFileSync(join(dir, 'token-open.txt'), `${T}\n`, { mode: 0o644 });
    expect(errorOf(() => parse({ proxies: [{ url: 'http://a', token: { file: 'token-open.txt' }, cameraUser: 'c', cameraPassword: PW }] }))).toBe('proxies[0].token: file token-open.txt is readable by others: chmod 600 it');
  });

  it('refuses a pin on a LAN http URL, takes it on loopback (spec §12.1)', () => {
    const p = (url: string) => ({ proxies: [{ url, token: T, cameraUser: 'c', cameraPassword: PW, caFingerprint: HEX }] });
    expect(errorOf(() => parse(p('http://192.168.1.230:8480')))).toBe('proxies[0].caFingerprint: needs an https url (or a loopback http one), else the token travels in clear');
    for (const url of ['http://127.0.0.1:8480', 'http://localhost:8480', 'http://[::1]:8480', 'https://192.168.1.230:8443']) expect(parse(p(url))[0].caFingerprint).toEqual([HEX]);
  });

  it('refuses a proxy tlsServername on an http url, like the registry', () => {
    expect(errorOf(() => parse({ proxies: [{ url: 'http://127.0.0.1:8480', tlsServername: 'proxy.x.internal', token: T, cameraUser: 'c', cameraPassword: PW }] }))).toBe('proxies[0].tlsServername: needs an https url');
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

  it('closes its pinned connection when done (the command line exits at once)', async () => {
    const f = await fakeProxy(true);
    await readProxyCameras(proxyIn(f, { tlsServername: 'proxy.test.internal', caFingerprint: [certFingerprint(fx('ca-a.pem'))] }));
    await expect.poll(() => f.openSockets(), { timeout: 2000 }).toBe(0);
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
    const gone = { id: 'garage-cam9', name: 'Gone', host: 'from-proxy', protocol: 'https', tlsServername: 'cam9.garage.internal', user: 'cams', password: PW, proxy: { url: G, token: T, camera: 'cam9', tlsServername: 'proxy.garage.internal', caFingerprint: HEX } };
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
