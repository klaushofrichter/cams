// The PTZ pass-through (cam-proxy spec 2026-10-30-ptz-capabilities-design §5,
// §8.2): moves, zoom, focus, stop and saved positions go to the camera's
// cam-proxy with its token; its answers come back as they are.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { until } from './helpers/wait';
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

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const req = (method: Method, id: string, path: string, body?: object) => {
  const r = request(createApp())[method](`/api/cameras/${id}${path}`).set('Cookie', auth);
  return body === undefined ? r : r.send(body);
};

describe('saved positions pass-through', () => {
  it('saves, lists, renames, makes Home, orders, re-saves, goes to and deletes through the proxy', async () => {
    const a = await req('post', 'den', '/ptz/positions', { name: '  Gate ' });
    expect([a.status, a.body.name, a.body.home, a.body.state]).toEqual([201, 'Gate', true, 'ok']);
    expect(fake.ptzCalls.at(-1)).toEqual({ cam: 'cam1', op: 'save', body: { name: 'Gate' } }); // sent trimmed
    const b = (await req('post', 'den', '/ptz/positions', { name: 'Door' })).body;
    expect(b.home).toBe(false);
    const ren = await req('patch', 'den', `/ptz/positions/${b.id}`, { name: 'Front door' });
    expect([ren.status, ren.body.name]).toEqual([200, 'Front door']);
    // the proxy's success status (200 or 204) is relayed as it is
    expect((await req('patch', 'den', `/ptz/positions/${b.id}`, { home: true })).status).toBeLessThan(300);
    expect((await req('put', 'den', '/ptz/positions/order', { ids: [b.id, a.body.id] })).status).toBeLessThan(300);
    const list = await req('get', 'den', '/ptz/positions');
    expect(list.body).toMatchObject({ max: 20, positions: [{ id: b.id, home: true, order: 0 }, { id: a.body.id, home: false, order: 1 }] });
    expect((await req('post', 'den', `/ptz/positions/${a.body.id}/save`)).status).toBe(200);
    expect((await req('post', 'den', `/ptz/positions/${a.body.id}/go`)).status).toBe(204);
    const d = await req('delete', 'den', `/ptz/positions/${b.id}`);
    expect([d.status, d.body]).toEqual([409, { error: 'home_position' }]);
    expect((await req('delete', 'den', `/ptz/positions/${a.body.id}`)).status).toBe(204);
    expect((await req('delete', 'den', `/ptz/positions/${b.id}`)).status).toBe(204); // the last one, Home, may go
    expect((await req('get', 'den', '/ptz/positions')).body).toEqual({ max: 20, positions: [] });
  });

  it.each([
    ['post', '/ptz/positions', { name: '   ' }],
    ['post', '/ptz/positions', { name: 'x'.repeat(41) }],
    ['post', '/ptz/positions', { name: 'a\u0007b' }],
    ['post', '/ptz/positions', { name: 7 }],
    ['post', '/ptz/positions', {}],
    ['patch', '/ptz/positions/pos_1', { home: false }],
    ['patch', '/ptz/positions/pos_1', {}],
    ['patch', '/ptz/positions/pos_1', { name: '' }],
    ['put', '/ptz/positions/order', { ids: ['pos_1', 'pos_1'] }],
    ['put', '/ptz/positions/order', { ids: [] }],
    ['put', '/ptz/positions/order', { ids: 'pos_1' }],
    ['put', '/ptz/positions/order', { ids: ['../x'] }],
    ['post', '/ptz/positions/..%2Fx/go', undefined],
    ['delete', '/ptz/positions/a.b', undefined],
  ] as [Method, string, object | undefined][])('refuses %s %s %j with 400 invalid before asking the proxy', async (method, path, body) => {
    const r = await req(method, 'den', path, body);
    expect([r.status, r.body.error]).toEqual([400, 'invalid']);
    expect(fake.requests.some((x) => x.path.includes('/ptz/'))).toBe(false);
  });

  it('relays limit_reached, no_free_slot, position_missing and name_taken as 409 with their codes', async () => {
    fake.capabilities.set('cam1', { schema: 1, ptz: { ...PTZ.ptz, positions: { max: 2 } } });
    const one = (await req('post', 'den', '/ptz/positions', { name: 'One' })).body;
    const taken = await req('post', 'den', '/ptz/positions', { name: 'one' });
    expect([taken.status, taken.body]).toEqual([409, { error: 'name_taken' }]);
    await req('post', 'den', '/ptz/positions', { name: 'Two' });
    const full = await req('post', 'den', '/ptz/positions', { name: 'Three' });
    expect([full.status, full.body]).toEqual([409, { error: 'limit_reached' }]);
    fake.ptzPositions.get('cam1')![0].state = 'missing';
    const go = await req('post', 'den', `/ptz/positions/${one.id}/go`);
    expect([go.status, go.body]).toEqual([409, { error: 'position_missing' }]);
    fake.ptzOverride = { status: 409, body: { error: 'no_free_slot' } };
    const slot = await req('post', 'den', `/ptz/positions/${one.id}/save`);
    expect([slot.status, slot.body]).toEqual([409, { error: 'no_free_slot' }]);
  });

  it("relays the proxy's own 404 for an unknown position and for a camera without positions", async () => {
    const r = await req('post', 'den', '/ptz/positions/pos_99/go');
    expect([r.status, r.body]).toEqual([404, { error: 'not_found' }]);
    fake.capabilities.set('cam1', { schema: 1, ptz: { move: true, zoom: false, focus: false, speed: false } });
    const n = await req('get', 'den', '/ptz/positions');
    expect([n.status, n.body]).toEqual([404, { error: 'not_supported' }]);
  });

  it('answers 404 no_proxy and 502 proxy_unavailable like the moves', async () => {
    expect((await req('get', 'shed', '/ptz/positions')).body).toEqual({ error: 'no_proxy' });
    fake.offline = true;
    const r = await req('post', 'den', '/ptz/positions', { name: 'Gate' });
    expect([r.status, r.body]).toEqual([502, { error: 'proxy_unavailable' }]);
  });
});

describe('the ptz-positions relay', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
  });

  it("tells the account's browsers which camera's positions changed", async () => {
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 200, healthyMs: 200 });
    const server = http.createServer(createApp()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    cleanup.push(() => {
      stopProxyStreams();
      server.closeAllConnections();
      server.close();
    });
    const frames: string[] = [];
    const get = http.get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events/stream`, { headers: { Cookie: auth } }, (res) => {
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
    get.on('error', () => undefined);
    cleanup.push(() => get.destroy());
    await until(() => frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    fake.push({ cam: 'barn', type: 'ptz-positions', data: {} }); // a camera of the proxy that isn't in this account
    fake.push({ cam: 'cam1', type: 'ptz-positions', data: {} });
    await until(() => frames.some((f) => f.startsWith('event: ptz-positions')));
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.filter((f) => f.startsWith('event: ptz-positions'))).toEqual(['event: ptz-positions\ndata: {"cam":"den"}']);
  });
});
