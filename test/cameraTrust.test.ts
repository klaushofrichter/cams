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

  it('keeps the cluster’s path to the Pi (LAN http, no pin)', () => {
    setCameras([{ id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'cams', password: 'pw', proxy: { url: 'http://192.168.1.220:8480', token: T } }]);
    expect(cameraTrust(getCamera('cam1')!)).toEqual({ kind: 'public', servername: 'cam1.skylar.technology' });
    expect(groupOf('cam1')).toMatchObject({ pins: null, tlsServername: null });
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
