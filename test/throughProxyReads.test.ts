// Camera reads of a through-proxy camera (spec §6.1): status, device,
// snapshot, settings and light come from the proxy; the camera at the
// configured host is never called.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { resetProxyCameraCalls } from '../server/proxy/cameraCalls';
import { CAMERA_CALLS, loadProxyFeatures, noteProxyFeatures } from '../server/proxy/features';
import { resetClients } from '../server/reolink/clients';
import { fileAccount } from '../server/fleet';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_ADMIN_TOKEN, FAKE_TOKEN, fakeStatus, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { createSimCamera, type SimState } from './camera/sim';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const FP = `SHA256:${'AB'.repeat(32)}`;
let fake: FakeProxy;
let camServer: Server;
let sim: SimState;
const get = (path: string) => request(createApp()).get(path).set('Cookie', auth);

async function setup(o: { adminToken?: boolean } = {}): Promise<void> {
  process.env.PROXY_FEATURES_FILE = join(mkdtempSync(join(tmpdir(), 'cams-through-')), 'f.json');
  loadProxyFeatures();
  const c = await createSimCamera({ user: 'u', password: 'p' });
  sim = c.state;
  camServer = c.app.listen(0);
  await new Promise((r) => camServer.once('listening', r));
  fake = await startFakeProxy();
  fake.features = ['sse-cam-list', CAMERA_CALLS];
  setCameras([{ id: 'den', name: 'Den', host: `127.0.0.1:${(camServer.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1', ...(o.adminToken !== false && { adminToken: FAKE_ADMIN_TOKEN }) } }]);
  resetProxyClients();
  resetClients();
  resetProxyCameraCalls();
  await noteProxyFeatures(fileAccount().id, fake.url, [{ features: [CAMERA_CALLS] }]);
}

beforeEach(() => setup());
afterEach(async () => {
  await fake.stop();
  await new Promise<void>((r) => camServer.close(() => r()));
  setCameras([]);
  delete process.env.PROXY_FEATURES_FILE;
  loadProxyFeatures();
  expect(sim.loginAttempts).toBe(0);
});

describe('status through the proxy', () => {
  it('answers online from the proxy', async () => {
    const r = await get('/api/cameras/den/status').expect(200);
    expect(r.body).toEqual({ id: 'den', online: true, model: 'RLC-1224A', firmware: 'v3.1.0.4054_2408163232', simulator: 'cam-sim', streams: { main: { codec: 'h265', width: 3840, height: 2160, fps: 20 }, sub: { codec: 'h264', width: 640, height: 360, fps: 15 } }, via: 'proxy' });
    expect(fake.requests.find((x) => x.path === '/api/cameras/cam1/status')?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('answers proxy_unreachable when the proxy is down', async () => {
    fake.offline = true;
    const r = await get('/api/cameras/den/status').expect(200);
    expect(r.body).toMatchObject({ id: 'den', online: false, error: 'proxy_unreachable', via: 'proxy', fix: { login: null, trust: null, canFix: true } });
    expect(r.body.offlineSince).toEqual(expect.any(Number));
  });

  it.each([
    [{ credentials: { source: 'none', authOk: null } }, 'camera_credentials_missing', { login: 'missing', trust: null }],
    [{ credentials: { source: 'store', authOk: false } }, 'camera_auth_failed', { login: 'refused', trust: null }],
    [{ tls: { mode: 'none', served: FP, problem: 'untrusted' } }, 'camera_untrusted', { login: null, trust: { fingerprint: FP } }],
    [{ tls: { mode: 'pinned', served: FP, problem: 'changed' } }, 'camera_cert_changed', { login: null, trust: { fingerprint: FP } }],
    [{ tls: { mode: 'none', served: null, problem: 'untrusted' } }, 'camera_untrusted', { login: null, trust: null }],
    [{}, 'camera_offline', { login: null, trust: null }],
  ])('answers offline %j as %s', async (over, error, fix) => {
    fake.cameraStatus.set('cam1', fakeStatus({ online: false, error: 'camera_offline', streams: { main: null, sub: null }, ...over }));
    const r = await get('/api/cameras/den/status').expect(200);
    expect(r.body).toMatchObject({ online: false, error, via: 'proxy', fix: { ...fix, canFix: true } });
  });

  it('says canFix false without an admin token', async () => {
    await fake.stop();
    await new Promise<void>((r) => camServer.close(() => r()));
    await setup({ adminToken: false });
    fake.cameraStatus.set('cam1', fakeStatus({ online: false, credentials: { source: 'none', authOk: null } }));
    const r = await get('/api/cameras/den/status').expect(200);
    expect(r.body.fix).toEqual({ login: 'missing', trust: null, canFix: false });
  });
});

describe('device, snapshot, settings and light through the proxy', () => {
  it('maps the device from the status', async () => {
    const validTo = new Date(Date.now() + 10.5 * 86_400_000).toUTCString();
    fake.cameraStatus.set('cam1', fakeStatus({ certificate: { subject: 'CN=cam', issuer: 'CN=ca', validTo } }));
    const r = await get('/api/cameras/den/device').expect(200);
    expect(r.body).toMatchObject({ model: 'RLC-1224A', firmware: 'v3.1.0.4054_2408163232', hardware: 'IPC_NT1NA48MP', name: 'Den', storage: { totalMb: 120000, usedMb: 60000, mounted: true }, certificate: { subject: 'CN=cam', issuer: 'CN=ca', validTo, daysLeft: 10 } });
    expect(r.body).toHaveProperty('webUiUrl');
  });

  it('streams the proxy\'s snapshot', async () => {
    const r = await get('/api/cameras/den/snapshot.jpg').expect(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(r.body as Buffer)).toEqual(JPEG);
    expect(fake.requests.find((x) => x.path === '/api/cameras/cam1/snapshot.jpg')?.query).toEqual({ stream: 'main' });
  });

  it('reads settings and the light from the proxy', async () => {
    const s = await get('/api/cameras/den/settings').expect(200);
    expect(s.body).toMatchObject({ detection: expect.any(Object), image: expect.any(Object) });
    const l = await get('/api/cameras/den/light').expect(200);
    expect(l.body).toEqual({ on: false });
  });

  it('answers 503 camera_offline when the proxy says so, 502 when it is gone', async () => {
    fake.cameraStatus.set('cam1', fakeStatus({ online: false, error: 'camera_offline' }));
    await get('/api/cameras/den/light').expect(503, { error: 'camera_offline' });
    await get('/api/cameras/den/snapshot.jpg').expect(503, { error: 'camera_offline' });
    fake.offline = true;
    await get('/api/cameras/den/settings').expect(502, { error: 'proxy_unavailable' });
    await get('/api/cameras/den/device').expect(502, { error: 'proxy_unavailable' });
  });
});
