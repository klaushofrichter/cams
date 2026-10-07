// test/proxyCameraList.test.ts
// The proxy's camera list (names, addresses, its web address) is read once
// per proxy, not once per cams camera.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { cameraName, setCameras, type FileCameraConfig } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { readProxyList } from '../server/proxy/cameraList';
import { proxyHub, proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import '../server/proxy/names';
import { loadProxyState } from '../server/proxyState';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { k } from './helpers/fleet';
import { fileAccount } from '../server/fleet';
import { camsIdOf, type CamKey } from '../server/fleet';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const cam = (id: string, proxy: FileCameraConfig['proxy']): FileCameraConfig => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy });
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
    const [x, y] = await Promise.all([readProxyList(k('den'), 3000), readProxyList(k('barn'), 3000)]);
    expect(x).toBe(y);
    expect(listReads()).toBe(1);
  });

  it('reads names for both cameras with one request when the stream comes up', async () => {
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
    await expect.poll(() => [cameraName(k('den')), cameraName(k('barn'))]).toEqual(['Den', 'Big Barn']);
    expect(proxyStates(fileAccount().id).every((s) => s.up)).toBe(true);
    expect(listReads()).toBe(1);
  });

  it('sends ?cam=a,b to a proxy that lists sse-cam-list', async () => {
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
    await expect.poll(() => proxyStates(fileAccount().id).length === 2 && proxyStates(fileAccount().id).every((s) => s.up)).toBe(true);
    expect(a.requests.filter((r) => r.path === '/api/stream').at(-1)?.query.cam).toBe('barn,cam1');
  });

  it('asks an older proxy (no features) for every camera and filters itself (the Pi before its update)', async () => {
    a.features = null; // ?cam=barn,cam1 would match nothing there
    const got: { cam: CamKey; data: Record<string, unknown> }[] = [];
    const on = (m: { cam: CamKey; data: Record<string, unknown> }) => got.push(m);
    proxyHub.on('message', on);
    try {
      startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
      await expect.poll(() => proxyStates(fileAccount().id).length === 2 && proxyStates(fileAccount().id).every((s) => s.up)).toBe(true);
      expect(a.requests.filter((r) => r.path === '/api/stream').at(-1)?.query.cam).toBeUndefined();
      a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
      a.push({ cam: 'cam9', type: 'clip', data: { clipId: 9 } });
      a.push({ cam: 'barn', type: 'clip', data: { clipId: 2 } });
      await expect.poll(() => got.length).toBe(2);
      expect(got.map((m) => [camsIdOf(m.cam), m.data.clipId])).toEqual([['den', 1], ['barn', 2]]);
    } finally {
      proxyHub.off('message', on);
    }
  });

  it('keeps ?cam=<id> for a one-camera group on an older proxy (the cluster proxy)', async () => {
    a.features = null;
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' })]);
    resetProxyClients();
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
    await expect.poll(() => proxyStates(fileAccount().id).every((s) => s.up) && proxyStates(fileAccount().id).length === 1).toBe(true);
    expect(a.requests.filter((r) => r.path === '/api/stream').at(-1)?.query.cam).toBe('cam1');
  });

  it('answers the Settings proxy info from the same list, per camera', async () => {
    const r = await request(createApp()).get('/api/cameras/barn/proxy/info').set('Cookie', auth);
    expect(r.body).toEqual({ reachable: true, webUrl: 'http://proxy.example:8480' });
  });
});
