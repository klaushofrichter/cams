import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { listCameras, listProxied, setCameras } from '../server/cameraRegistry';
import { getProxyClient, resetProxyClients } from '../server/proxy/client';
import { loadProxyState, proxyEnabled, setProxyEnabled } from '../server/proxyState';
import { proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { findProxyClip } from '../server/recordings/proxyClips';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

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
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
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
