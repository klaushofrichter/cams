import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { listCameras, listProxied, setCameras } from '../server/cameraRegistry';
import { getProxyClient, resetProxyClients } from '../server/proxy/client';
import { loadProxyState, proxyEnabled, setProxyEnabled } from '../server/proxyState';
import { proxyHub, proxyStates, startProxyStream, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { findProxyClip, openProxyClip } from '../server/recordings/proxyClips';
import { getRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_ADMIN_TOKEN, FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

// The per-camera "use cam-proxy" switch: one server-side setting per camera,
// for all users, kept across restarts.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const M = Date.UTC(2026, 8, 27, 19, 3);
let fake: FakeProxy;
let file: string;

beforeEach(async () => {
  file = join(await fs.mkdtemp(join(tmpdir(), 'cams-proxy-state-')), 'proxy-state.json');
  process.env.PROXY_STATE_FILE = file;
  loadProxyState();
  fake = await startFakeProxy();
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
  fake.stills.set('cam1', new Map([[M + 1000, JPEG]]));
});
afterEach(async () => {
  stopProxyStreams();
  await fake.stop();
  setCameras([]);
  process.env.PROXY_STATE_FILE = join(tmpdir(), 'cams-proxy-state-none', 'absent.json');
  loadProxyState();
  delete process.env.PROXY_STATE_FILE;
});

const put = (id: string, body: unknown) => request(createApp()).put(`/api/cameras/${id}/proxy`).set('Cookie', auth).send(body as object);

describe('proxy state file', () => {
  it('is on by default and remembers a switch across a restart', async () => {
    expect(proxyEnabled('den')).toBe(true);
    await setProxyEnabled('den', false);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ den: false });
    loadProxyState(); // a restart
    expect(proxyEnabled('den')).toBe(false);
    await setProxyEnabled('den', true);
    loadProxyState();
    expect(proxyEnabled('den')).toBe(true);
  });

  it('lives next to the preferences file when PROXY_STATE_FILE is unset', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'cams-prefs-dir-'));
    delete process.env.PROXY_STATE_FILE;
    const prefs = process.env.PREFS_FILE;
    process.env.PREFS_FILE = join(dir, 'preferences.json');
    try {
      loadProxyState();
      await setProxyEnabled('den', false);
      expect(JSON.parse(await fs.readFile(join(dir, 'proxy-state.json'), 'utf8'))).toEqual({ den: false });
    } finally {
      if (prefs === undefined) delete process.env.PREFS_FILE;
      else process.env.PREFS_FILE = prefs;
    }
  });

  it('reads a corrupt file as all on', async () => {
    await fs.writeFile(file, 'not json');
    loadProxyState();
    expect(proxyEnabled('den')).toBe(true);
  });
});

describe('PUT /api/cameras/:id/proxy', () => {
  it('needs a signed-in user', async () => {
    expect((await request(createApp()).put('/api/cameras/den/proxy').send({ enabled: false })).status).toBe(401);
  });

  it('refuses unknown cameras, cameras without a proxy, and bad bodies', async () => {
    expect((await put('nope', { enabled: false })).status).toBe(404);
    expect((await put('shed', { enabled: false })).body).toEqual({ error: 'no_proxy' });
    expect((await put('den', { enabled: 'no' })).status).toBe(400);
    expect((await put('den', {})).status).toBe(400);
  });

  it('turns the proxy off for everything, and on again', async () => {
    const off = await put('den', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ enabled: false });
    expect(listCameras().find((c) => c.id === 'den')).toMatchObject({ proxy: false, proxyConfigured: true });
    expect(listCameras().find((c) => c.id === 'shed')).toMatchObject({ proxy: false, proxyConfigured: false });
    expect(listProxied()).toEqual([]);
    expect(getProxyClient('den')).toBeUndefined();
    const before = fake.requests.length;
    expect((await request(createApp()).get(`/api/cameras/den/stills?from=${M}&to=${M + 60_000}`).set('Cookie', auth)).status).toBe(404);
    expect(await findProxyClip('den', M, M + 10_000)).toBeNull();
    expect(fake.requests.length).toBe(before); // the proxy was never asked

    expect((await put('den', { enabled: true })).body).toEqual({ enabled: true });
    expect(listCameras().find((c) => c.id === 'den')).toMatchObject({ proxy: true, proxyConfigured: true });
    const s = await request(createApp()).get(`/api/cameras/den/stills?from=${M}&to=${M + 60_000}`).set('Cookie', auth);
    expect(s.body).toEqual([M + 1000]);
  });

  it('stops the camera’s event stream when off and restarts it when on', async () => {
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
    await expect.poll(() => proxyStates().find((s) => s.cam === 'den')?.up).toBe(true);
    await put('den', { enabled: false });
    expect(proxyStates().find((s) => s.cam === 'den')).toBeUndefined();
    await put('den', { enabled: true });
    await expect.poll(() => proxyStates().find((s) => s.cam === 'den')?.up).toBe(true);
  });
});

describe('switch edge cases (review)', () => {
  it('keeps the old setting when the file cannot be written (I1)', async () => {
    process.env.PROXY_STATE_FILE = await fs.mkdtemp(join(tmpdir(), 'cams-proxy-state-dir-')); // a folder: rename fails
    const res = await put('den', { enabled: false });
    expect(res.status).toBe(500);
    expect(proxyEnabled('den')).toBe(true);
    expect(listCameras().find((c) => c.id === 'den')?.proxy).toBe(true);
  });

  it('tells every browser that the camera list changed, and that the proxy is gone (I2)', async () => {
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
    await expect.poll(() => proxyStates().find((s) => s.cam === 'den')?.up).toBe(true);
    const server = http.createServer(createApp()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const frames: string[] = [];
    const req = http.get(`${base}/api/events/stream`, { headers: { Cookie: auth } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => frames.push(...d.split('\n\n')));
    });
    try {
      await expect.poll(() => frames.some((f) => f.includes('event: proxy'))).toBe(true);
      const states: unknown[] = [];
      const onState = (x: unknown) => states.push(x);
      proxyHub.on('state', onState);
      await request(base).put('/api/cameras/den/proxy').set('Cookie', auth).send({ enabled: false });
      proxyHub.off('state', onState);
      await expect.poll(() => frames.some((f) => f.startsWith('event: cameras'))).toBe(true);
      expect(frames.some((f) => f.startsWith('event: change') && f.includes('"reset"') && f.includes('"den"'))).toBe(true);
      expect(states).toEqual([{ cam: 'den', up: false }]); // once (M6)
    } finally {
      req.destroy();
      server.closeAllConnections();
      server.close();
    }
  });

  it('stops reporting recordings as coming from the proxy when it is off (I3)', async () => {
    expect(getRecordings().downloadsState('den')).toBe('proxy');
    await put('den', { enabled: false });
    expect(getRecordings().downloadsState('den')).toBe('ok');
  });

  it('starts no event stream at boot for a camera switched off (I3)', async () => {
    await fs.writeFile(file, JSON.stringify({ den: false }));
    loadProxyState();
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
    expect(proxyStates()).toEqual([]);
  });

  it('fails a clip open with a proxy error, not a crash, once switched off (M5)', async () => {
    await setProxyEnabled('den', false);
    await expect(openProxyClip('den', 1)).rejects.toMatchObject({ name: 'ProxyError' });
  });

  it('starts no stream after shutdown began (M7)', () => {
    stopProxyStreams(true);
    startProxyStream('den');
    expect(proxyStates()).toEqual([]);
  });
});

describe('GET /api/cameras/:id/proxy/info (the Settings link, Klaus 2026-09-28)', () => {
  const info = (id: string) => request(createApp()).get(`/api/cameras/${id}/proxy/info`).set('Cookie', auth);
  it('names the proxy’s web address while it answers', async () => {
    fake.publicUrl = 'https://proxy.example';
    expect((await info('den')).body).toEqual({ reachable: true, webUrl: 'https://proxy.example' });
  });

  it('says unreachable, with no link, when the proxy does not answer', async () => {
    await fake.stop();
    expect((await info('den')).body).toEqual({ reachable: false, webUrl: null });
    fake = await startFakeProxy(); // afterEach stops it again
  });

  it('answers reachable without a link when the proxy says something odd, or lists only other cameras (review)', async () => {
    fake.camerasBody = { not: 'a list' };
    expect((await info('den')).body).toEqual({ reachable: true, webUrl: null });
    fake.camerasBody = [{ id: 'other', publicUrl: 'https://other.example' }];
    expect((await info('den')).body).toEqual({ reachable: true, webUrl: null });
  });

  it('refuses a camera without a proxy', async () => {
    expect((await info('shed')).body).toEqual({ error: 'no_proxy' });
  });
});


// A signed-in cams user opens the proxy's UI without its token (Klaus,
// 2026-09-28): cams mints a one-time link with the proxy's admin token.
describe('POST /api/cameras/:id/proxy/login-link', () => {
  const link = (id: string, cookie = auth) => request(createApp()).post(`/api/cameras/${id}/proxy/login-link`).set('Cookie', cookie);
  const withAdmin = () => setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, adminToken: FAKE_ADMIN_TOKEN, camera: 'cam1' } },
  ]);

  it('answers a one-time link into the proxy UI at its public address', async () => {
    withAdmin();
    fake.publicUrl = 'https://proxy.example';
    const r = await link('den');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ url: 'https://proxy.example/control/login-link?code=fake-code-1' });
    expect(fake.requests.find((q) => q.path === '/control/login-links')?.auth).toBe(`Bearer ${FAKE_ADMIN_TOKEN}`);
  });

  it('needs a signed-in user', async () => {
    withAdmin();
    expect((await link('den', 'x=y')).status).toBe(401);
    expect(fake.loginLinks).toBe(0);
  });

  it('says so when it can’t: no admin token, no public address, or the proxy down', async () => {
    fake.publicUrl = 'https://proxy.example';
    expect((await link('den')).body).toEqual({ error: 'no_login_link' }); // den has no admin token here
    withAdmin();
    fake.publicUrl = null;
    expect((await link('den')).body).toEqual({ error: 'no_login_link' });
    fake.publicUrl = 'https://proxy.example';
    await fake.stop();
    expect((await link('den')).status).toBe(502);
    fake = await startFakeProxy();
  });

  it('never shows the admin token in the camera list', async () => {
    withAdmin();
    expect(JSON.stringify(listCameras())).not.toContain(FAKE_ADMIN_TOKEN);
  });

  // Issue #69: a public address with a path or a query.
  it('builds the link under a public address with a path, without its query', async () => {
    withAdmin();
    fake.publicUrl = 'https://proxy.example/base/?x=1#y';
    expect((await link('den')).body).toEqual({ url: 'https://proxy.example/base/control/login-link?code=fake-code-1' });
  });
});
