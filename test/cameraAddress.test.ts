import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { cameraHost, listCameras, loadCameras, setCameras, setReportedAddress, type CameraConfig } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { getClient, resetClients } from '../server/reolink/clients';
import { CameraError } from '../server/reolink/client';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

// Spec 2026-10-04-camera-address-from-proxy-design: a camera with
// "host": "from-proxy" is reached at the address its cam-proxy reports.

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  setCameras([]);
  resetClients();
  resetProxyClients();
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'cams-addr-'));
const file = (name: string, v: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(v));
  return p;
};
const proxy = { url: 'http://127.0.0.1:1', token: 't'.repeat(32) };
const den = { id: 'den', name: 'Den', host: 'from-proxy', tlsServername: 'cam1.example.test', user: 'cams', password: 'pw', proxy };

describe('the cameras file', () => {
  it('takes "host": "from-proxy" for a camera with a proxy', () => {
    const [c] = loadCameras(file('ok.json', [den]));
    expect(c.host).toBe('from-proxy');
  });
  // Security review 2026-10-04: an address from the proxy is only trusted
  // behind a certificate check, so a compromised proxy can't point the
  // camera login (user, password) at another host.
  it('requires https and a tlsServername with "from-proxy"', () => {
    expect(loadCameras(file('def.json', [den]))[0].protocol).toBe('https');
    expect(() => loadCameras(file('http.json', [{ ...den, protocol: 'http' }]))).toThrow('camera registry entry 0: host "from-proxy" needs protocol "https" and a tlsServername (or a proxy caFingerprint)');
    const { tlsServername: _t, ...noName } = den;
    expect(() => loadCameras(file('nosni.json', [noName]))).toThrow('camera registry entry 0: host "from-proxy" needs protocol "https" and a tlsServername (or a proxy caFingerprint)');
  });
  it('refuses "from-proxy" without a proxy, and still refuses a missing host', () => {
    const { proxy: _p, ...noProxy } = den;
    expect(() => loadCameras(file('np.json', [noProxy]))).toThrow('camera registry entry 0: host "from-proxy" needs a proxy');
    const { host: _h, ...noHost } = den;
    expect(() => loadCameras(file('nh.json', [noHost]))).toThrow(/entry 0: field "host"/);
  });
});

describe('the reported address', () => {
  const cams = (list: CameraConfig[]) => setCameras(list);
  it('is unknown until reported; then used; invalid values are ignored; explicit hosts never change', () => {
    cams([{ ...den, protocol: 'https' }, { id: 'shed', name: 'Shed', host: '10.0.0.9', protocol: 'https', user: 'u', password: 'p' }]);
    expect(cameraHost('den')).toBeUndefined();
    expect(listCameras().find((c) => c.id === 'den')?.webUiUrl).toBeNull();
    setReportedAddress('den', '192.0.2.20');
    expect(cameraHost('den')).toBe('192.0.2.20');
    expect(listCameras().find((c) => c.id === 'den')?.webUiUrl).toBe('https://192.0.2.20/');
    for (const bad of ['', 'http://x', 'a b', '1.2.3.4:0', '1.2.3.4:70000', 7, null]) setReportedAddress('den', bad);
    expect(cameraHost('den')).toBe('192.0.2.20');
    setReportedAddress('shed', '10.0.0.1');
    expect(cameraHost('shed')).toBe('10.0.0.9');
  });

  it('the direct client answers camera_address_unknown without a network call, then uses the address; a change drops the client', async () => {
    cams([{ ...den, protocol: 'http' }]);
    const err = await getClient('den')!.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).code).toBe('camera_address_unknown');
    expect(await getClient('den')!.cameraCertificate()).toBeNull();
    // A tiny camera that refuses the login: proves the request went to it.
    const hits: string[] = [];
    const cam = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ cmd: 'Login', code: 1, error: { rspCode: -7 } }]));
    });
    cam.listen(0, '127.0.0.1');
    await new Promise((r) => cam.once('listening', r));
    cleanup.push(() => cam.close());
    const before = getClient('den');
    setReportedAddress('den', `127.0.0.1:${(cam.address() as AddressInfo).port}`);
    expect(getClient('den')).not.toBe(before);
    const e2 = await getClient('den')!.status().catch((e: unknown) => e);
    expect((e2 as CameraError).code).toBe('camera_auth_failed');
    expect(hits.some((u) => u.includes('cmd=Login'))).toBe(true);
    // A known address changes to another: the cached client is dropped and
    // the next request goes to the new address only.
    const known = getClient('den');
    expect(getClient('den')).toBe(known); // cached while the address stays
    setReportedAddress('den', '127.0.0.1:9');
    const moved = getClient('den');
    expect(moved).not.toBe(known);
    const n = hits.length;
    const e3 = await moved!.status().catch((e: unknown) => e);
    expect((e3 as CameraError).code).toBe('camera_offline');
    expect(hits.length).toBe(n);
  });
});

describe('from the cam-proxy', () => {
  async function serve(fake: FakeProxy): Promise<string> {
    setCameras([{ ...den, protocol: 'http', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } }]);
    resetProxyClients();
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 200, healthyMs: 200 });
    const server = http.createServer(createApp()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    cleanup.push(() => {
      stopProxyStreams();
      server.closeAllConnections();
      server.close();
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('reads the address when the stream comes up, follows the camera message, and keeps it while the proxy is away', async () => {
    const fake = await startFakeProxy();
    cleanup.push(() => fake.stop());
    fake.cameraAddresses.set('cam1', '192.0.2.20');
    const base = await serve(fake);
    await until(() => cameraHost('den') === '192.0.2.20');
    // A message with the address alone (no name told yet), and one with both.
    fake.push({ cam: 'cam1', type: 'camera', data: { address: '192.0.2.21' } });
    await until(() => cameraHost('den') === '192.0.2.21');
    fake.push({ cam: 'cam1', type: 'camera', data: { name: 'Den', address: '127.0.0.1:9' } });
    await until(() => cameraHost('den') === '127.0.0.1:9');
    fake.offline = true;
    fake.dropStreams();
    await new Promise((r) => setTimeout(r, 300));
    expect(cameraHost('den')).toBe('127.0.0.1:9');
    // The status route still answers from the camera directly (offline here).
    const st = await request(base).get('/api/cameras/den/status').set('Cookie', auth);
    expect(st.body).toMatchObject({ id: 'den', online: false, error: 'camera_offline' });
  });

  it('until the proxy answered, the status route says camera_address_unknown', async () => {
    const fake = await startFakeProxy();
    cleanup.push(() => fake.stop());
    fake.offline = true;
    const base = await serve(fake);
    const st = await request(base).get('/api/cameras/den/status').set('Cookie', auth);
    expect(st.body).toMatchObject({ id: 'den', online: false, error: 'camera_address_unknown' });
    const snap = await request(base).get('/api/cameras/den/snapshot.jpg').set('Cookie', auth);
    expect(snap.status).toBe(503);
    expect(snap.body).toEqual({ error: 'camera_address_unknown' });
  });
});
