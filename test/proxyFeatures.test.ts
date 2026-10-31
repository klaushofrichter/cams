// The per-proxy switch to camera calls through the proxy (cam-proxy spec
// 2026-10-30-camera-onboarding-design §6.1, §8): a camera whose proxy lists
// `camera-calls` in its camera list goes through that proxy only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { proxyActive, setCameras, type FileCameraConfig } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { readProxyList } from '../server/proxy/cameraList';
import { CAMERA_CALLS, featureEvents, loadProxyFeatures, noteProxyFeatures, proxyFeaturesFile, throughProxy, throughProxyAt } from '../server/proxy/features';
import { loadProxyState, setProxyEnabled } from '../server/proxyState';
import { SESSION_COOKIE, signSession } from '../server/session';
import { setFleet, fileAccount } from '../server/fleet';
import { keyed } from '../server/cameraRegistry';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { ALPHA, ALPHA_REF, BETA, BETA_REF, k } from './helpers/fleet';
import { camKey } from '../server/fleet';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const cam = (id: string, url: string, extra: Partial<FileCameraConfig> = {}): FileCameraConfig => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url, token: FAKE_TOKEN, camera: 'cam1' }, ...extra });
let fake: FakeProxy;
let file: string;
let events: { accountId: string; proxyUrl: string; on: boolean }[];
const onThrough = (e: { accountId: string; proxyUrl: string; on: boolean }) => events.push(e);

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cams-features-'));
  file = join(dir, 'proxy-features.json');
  process.env.PROXY_FEATURES_FILE = file;
  process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
  loadProxyFeatures();
  loadProxyState();
  fake = await startFakeProxy();
  setCameras([cam('den', fake.url), { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]);
  resetProxyClients();
  events = [];
  featureEvents.on('through', onThrough);
});
afterEach(async () => {
  featureEvents.off('through', onThrough);
  await fake.stop();
  setCameras([]);
  delete process.env.PROXY_FEATURES_FILE;
  delete process.env.PROXY_STATE_FILE;
  loadProxyFeatures();
  loadProxyState();
});

describe('per-proxy switch', () => {
  it('turns a camera through-proxy when its proxy lists camera-calls, and back on a rollback', async () => {
    expect(throughProxy(k('den'))).toBe(false);
    fake.features = ['ptz', CAMERA_CALLS];
    await readProxyList(k('den'), 3000, { maxAgeMs: 0 });
    await expect.poll(() => throughProxy(k('den'))).toBe(true);
    expect(throughProxy(k('shed'))).toBe(false);
    fake.features = ['ptz'];
    await readProxyList(k('den'), 3000, { maxAgeMs: 0 });
    await expect.poll(() => throughProxy(k('den'))).toBe(false);
    expect(events.map((e) => e.on)).toEqual([true, false]);
    expect(events[0]).toMatchObject({ accountId: fileAccount().id, proxyUrl: fake.url });
  });

  it('keeps the switch over a restart with the proxy down', async () => {
    await noteProxyFeatures(fileAccount().id, fake.url, [{ features: [CAMERA_CALLS] }]);
    await fake.stop();
    loadProxyFeatures(); // a restart
    expect(throughProxy(k('den'))).toBe(true);
    fake = await startFakeProxy(); // afterEach stops it
  });

  it('keys by account and URL', async () => {
    await noteProxyFeatures(ALPHA, fake.url, [{ features: [CAMERA_CALLS] }]);
    expect(throughProxyAt(ALPHA, fake.url)).toBe(true);
    expect(throughProxyAt(ALPHA, `${fake.url}/`)).toBe(true);
    expect(throughProxyAt(BETA, fake.url)).toBe(false);
    setFleet([
      { ...ALPHA_REF, users: null, cameras: keyed(ALPHA, [cam('cam1', fake.url)]) },
      { ...BETA_REF, users: null, cameras: keyed(BETA, [cam('cam1', fake.url), cam('moved', 'http://127.0.0.1:9/other')]) },
    ]);
    expect(throughProxy(camKey(ALPHA, 'cam1'))).toBe(true);
    expect(throughProxy(camKey(BETA, 'cam1'))).toBe(false);
    // A camera moved to another URL stays direct until that list is read.
    expect(throughProxy(camKey(BETA, 'moved'))).toBe(false);
  });

  it('ignores junk in features and a failed list read', async () => {
    await noteProxyFeatures(fileAccount().id, fake.url, [{ features: [1, 'A B', 'x'.repeat(40), CAMERA_CALLS] }, null, { features: 'camera-calls' }]);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { v: number; proxies: Record<string, { features: string[] }> };
    expect(Object.values(saved.proxies)[0].features).toEqual([CAMERA_CALLS]);
    expect(throughProxy(k('den'))).toBe(true);
    // A failed read (the proxy is gone) changes nothing.
    fake.offline = true;
    await readProxyList(k('den'), 1000, { maxAgeMs: 0 }).catch(() => undefined);
    expect(throughProxy(k('den'))).toBe(true);
    expect(events.map((e) => e.on)).toEqual([true]);
  });

  it('stores neither the token nor the URL in the file', async () => {
    fake.features = [CAMERA_CALLS];
    await readProxyList(k('den'), 3000, { maxAgeMs: 0 });
    await expect.poll(() => throughProxy(k('den'))).toBe(true);
    const text = await fs.readFile(proxyFeaturesFile(), 'utf8');
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain('127.0.0.1');
    expect(JSON.parse(text)).toMatchObject({ v: 1 });
  });

  it('refuses switching a through-proxy camera to direct (409 proxy_required)', async () => {
    await setProxyEnabled(k('den'), false);
    expect(proxyActive(k('den'))).toBe(false);
    await noteProxyFeatures(fileAccount().id, fake.url, [{ features: [CAMERA_CALLS] }]);
    expect(proxyActive(k('den'))).toBe(true); // whatever the switch says
    const r = await request(createApp()).put('/api/cameras/den/proxy').set('Cookie', auth).send({ enabled: false });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'proxy_required' });
    await request(createApp()).put('/api/cameras/den/proxy').set('Cookie', auth).send({ enabled: true }).expect(200);
  });

  it('lists throughProxy per camera in GET /api/cameras', async () => {
    await noteProxyFeatures(fileAccount().id, fake.url, [{ features: [CAMERA_CALLS] }]);
    const r = await request(createApp()).get('/api/cameras').set('Cookie', auth).expect(200);
    const by = Object.fromEntries((r.body as { id: string; throughProxy: boolean }[]).map((c) => [c.id, c.throughProxy]));
    expect(by).toEqual({ den: true, shed: false });
  });
});
