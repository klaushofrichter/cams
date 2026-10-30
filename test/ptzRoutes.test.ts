// The PTZ pass-through (cam-proxy spec 2026-10-30-ptz-capabilities-design §5,
// §8.2): moves, zoom, focus, stop and saved positions go to the camera's
// cam-proxy with its token; its answers come back as they are.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const PTZ = { schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } };
let fake: FakeProxy;

beforeEach(async () => {
  fake = await startFakeProxy();
  fake.features = ['sse-cam-list', 'ptz'];
  fake.capabilities.set('cam1', PTZ);
  // den: through the fake proxy's cam1 (a PTZ camera); shed: no proxy.
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
});
afterEach(async () => {
  await fake.stop();
  setCameras([]);
});

const post = (id: string, op: string, body?: object) => {
  const r = request(createApp()).post(`/api/cameras/${id}/ptz/${op}`).set('Cookie', auth);
  return body === undefined ? r : r.send(body);
};

describe('PTZ control pass-through', () => {
  it('forwards a move with only the known fields and answers 204', async () => {
    const r = await post('den', 'move', { direction: 'left-up', speed: 7, durationMs: 600, extra: 1 });
    expect(r.status).toBe(204);
    expect(fake.ptzCalls.at(-1)).toEqual({ cam: 'cam1', op: 'move', body: { direction: 'left-up', speed: 7, durationMs: 600 } });
    expect(fake.requests.at(-1)?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
    await post('den', 'move', { direction: 'down' });
    expect(fake.ptzCalls.at(-1)).toEqual({ cam: 'cam1', op: 'move', body: { direction: 'down' } });
  });

  it.each([
    [{ direction: 'north' }],
    [{}],
    [{ direction: 'left', speed: 0 }],
    [{ direction: 'left', speed: 11 }],
    [{ direction: 'left', speed: 2.5 }],
    [{ direction: 'left', speed: '5' }],
    [{ direction: 'left', durationMs: 99 }],
    [{ direction: 'left', durationMs: 2001 }],
  ])('refuses %j with 400 invalid and calls nothing', async (b) => {
    const r = await post('den', 'move', b);
    expect([r.status, r.body.error]).toEqual([400, 'invalid']);
    expect(typeof r.body.detail).toBe('string');
    expect(fake.ptzCalls).toEqual([]);
  });

  it('forwards zoom in|out, focus near|far and stop', async () => {
    expect((await post('den', 'zoom', { direction: 'in', durationMs: 600 })).status).toBe(204);
    expect((await post('den', 'zoom', { direction: 'out' })).status).toBe(204);
    expect((await post('den', 'focus', { direction: 'near', durationMs: 400 })).status).toBe(204);
    expect((await post('den', 'focus', { direction: 'far' })).status).toBe(204);
    expect((await post('den', 'stop', { anything: 1 })).status).toBe(204);
    expect(fake.ptzCalls).toEqual([
      { cam: 'cam1', op: 'zoom', body: { direction: 'in', durationMs: 600 } },
      { cam: 'cam1', op: 'zoom', body: { direction: 'out' } },
      { cam: 'cam1', op: 'focus', body: { direction: 'near', durationMs: 400 } },
      { cam: 'cam1', op: 'focus', body: { direction: 'far' } },
      { cam: 'cam1', op: 'stop', body: {} },
    ]);
    for (const [op, b] of [['zoom', { direction: 'near' }], ['focus', { direction: 'in' }], ['zoom', { direction: 'in', durationMs: 50 }]] as const) {
      const r = await post('den', op, b);
      expect([r.status, r.body.error]).toEqual([400, 'invalid']);
    }
    expect(fake.ptzCalls).toHaveLength(5);
  });

  it("relays the proxy's refusals as they are", async () => {
    for (const [status, error] of [[404, 'not_supported'], [503, 'camera_offline'], [502, 'camera_error']] as const) {
      fake.ptzOverride = { status, body: { error } };
      const r = await post('den', 'move', { direction: 'up' });
      expect([r.status, r.body]).toEqual([status, { error }]);
    }
  });

  it("relays the fake proxy's own not_supported for a camera without zoom, focus or PTZ", async () => {
    fake.capabilities.set('cam1', { schema: 1, ptz: { move: true, zoom: false, focus: false, speed: true } });
    expect([(await post('den', 'zoom', { direction: 'in' })).status, (await post('den', 'focus', { direction: 'far' })).body]).toEqual([404, { error: 'not_supported' }]);
    expect((await post('den', 'move', { direction: 'up' })).status).toBe(204);
    fake.capabilities.set('cam1', { schema: 1, ptz: null });
    const r = await post('den', 'move', { direction: 'up' });
    expect([r.status, r.body]).toEqual([404, { error: 'not_supported' }]);
  });

  it("answers 404 no_proxy for a camera without a proxy, 404 unknown_camera for another account's", async () => {
    const a = await post('shed', 'move', { direction: 'up' });
    expect([a.status, a.body.error]).toEqual([404, 'no_proxy']);
    const b = await post('elsewhere', 'stop');
    expect([b.status, b.body.error]).toEqual([404, 'unknown_camera']);
    expect(fake.ptzCalls).toEqual([]);
  });

  it('answers 502 proxy_unavailable when the proxy is down', async () => {
    fake.offline = true;
    const r = await post('den', 'move', { direction: 'up' });
    expect([r.status, r.body]).toEqual([502, { error: 'proxy_unavailable' }]);
  });
});
