import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../server/app';
import { listCameras, setCameras, type FileCameraConfig } from '../server/cameraRegistry';
import { parseCapabilities } from '../server/proxy/capabilities';
import { resetProxyClients } from '../server/proxy/client';
import { startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { setProxyEnabled } from '../server/proxyState';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { fileAccount } from '../server/fleet';
import { k } from './helpers/fleet';
import { until } from './helpers/wait';

// A camera's capabilities from its cam-proxy (cam-proxy spec
// 2026-10-30-ptz-capabilities-design §4): passed on in GET /api/cameras.
const PTZ = { schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } };

describe('parseCapabilities', () => {
  it('takes the proxy object when features lists ptz', () => expect(parseCapabilities({ features: ['sse-cam-list', 'ptz'], capabilities: PTZ })).toEqual(PTZ));
  it('drops ptz when the proxy does not list the ptz feature', () => expect(parseCapabilities({ features: ['sse-cam-list'], capabilities: PTZ })).toEqual({ schema: 1, ptz: null }));
  it('is null without a capabilities object', () => {
    for (const c of [undefined, null, 'x', 3, []]) expect(parseCapabilities({ features: ['ptz'], capabilities: c })).toBeNull();
    expect(parseCapabilities({ features: ['ptz'], capabilities: { ptz: PTZ.ptz } })).toBeNull(); // no schema
    expect(parseCapabilities(undefined)).toBeNull();
  });
  it('reads non-booleans as false and an implausible positions.max as no positions', () =>
    expect(parseCapabilities({ features: ['ptz'], capabilities: { schema: 1, ptz: { move: 'yes', zoom: true, positions: { max: 500 } } } })).toEqual({
      schema: 1,
      ptz: { move: false, zoom: true, focus: false, speed: false, positions: null },
    }));
  it('reads a camera without presets (no positions field) as positions null', () =>
    expect(parseCapabilities({ features: ['ptz'], capabilities: { schema: 1, ptz: { move: true, zoom: false, focus: false, speed: true } } })).toEqual({
      schema: 1,
      ptz: { move: true, zoom: false, focus: false, speed: true, positions: null },
    }));
  it('reads ptz null (a fixed camera) as ptz null', () => expect(parseCapabilities({ features: ['ptz'], capabilities: { schema: 1, ptz: null } })).toEqual({ schema: 1, ptz: null }));
  it('accepts a later schema and keeps only what it knows', () => expect(parseCapabilities({ features: ['ptz'], capabilities: { ...PTZ, schema: 2, light: {} } })).toEqual(PTZ));
});

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(): Promise<{ fake: FakeProxy; base: string }> {
  const fake = await startFakeProxy();
  cleanup.push(() => fake.stop());
  fake.features = ['sse-cam-list', 'ptz'];
  fake.capabilities.set('cam1', PTZ);
  // den: through the fake proxy's cam1; shed: no proxy.
  const list: FileCameraConfig[] = [
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ];
  setCameras(list);
  resetProxyClients();
  cleanup.push(() => setCameras([]));
  startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 200, healthyMs: 200 });
  const server = http.createServer(createApp()).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  cleanup.push(() => {
    stopProxyStreams();
    server.closeAllConnections();
    server.close();
  });
  return { fake, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function browser(base: string) {
  const frames: string[] = [];
  const req = http.get(`${base}/api/events/stream`, { headers: { Cookie: auth } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        frames.push(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    });
  });
  req.on('error', () => undefined);
  cleanup.push(() => req.destroy());
  return frames;
}

const capsOf = (id: string) => listCameras(fileAccount().id).find((c) => c.id === id)?.capabilities;

describe('capabilities in GET /api/cameras', () => {
  it('lists den with its capabilities once the proxy stream is up, shed with null', async () => {
    const { base } = await setup();
    await until(() => capsOf('den') !== null);
    const res = await request(base).get('/api/cameras').set('Cookie', auth);
    expect(res.body.map((c: { id: string; capabilities: unknown }) => [c.id, c.capabilities])).toEqual([
      ['den', PTZ],
      ['shed', null],
    ]);
  });

  it('answers null for den while its proxy is switched off', async () => {
    await setup();
    await until(() => capsOf('den') !== null);
    await setProxyEnabled(k('den'), false);
    cleanup.push(() => setProxyEnabled(k('den'), true));
    expect(capsOf('den')).toBeNull();
  });

  it("sends event: cameras to the account's browsers when a camera message brings changed capabilities", async () => {
    const { fake, base } = await setup();
    const frames = browser(base);
    await until(() => capsOf('den') !== null);
    await until(() => frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    const before = frames.filter((f) => f.startsWith('event: cameras\n')).length;
    fake.capabilities.set('cam1', { schema: 1, ptz: null });
    fake.push({ cam: 'cam1', type: 'camera', data: { name: 'Den' } });
    await until(() => frames.filter((f) => f.startsWith('event: cameras\n')).length > before);
    expect(capsOf('den')).toEqual({ schema: 1, ptz: null });
    // The same capabilities again: nothing to tell.
    const after = frames.filter((f) => f.startsWith('event: cameras\n')).length;
    fake.push({ cam: 'cam1', type: 'camera', data: { name: 'Den' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.filter((f) => f.startsWith('event: cameras\n')).length).toBe(after);
  });
});
