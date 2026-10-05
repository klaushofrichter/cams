// test/cameraImport.test.ts
// The cameras.json generator's logic (cam-proxy spec 2026-10-05 §13.3;
// scripts/cameras-config.ts is its command line).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImportError, parseImportInput, readProxyCameras, type ImportProxy } from '../server/cameraImport';
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