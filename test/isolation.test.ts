// No data crosses accounts (migration P4, M §9.6, Review Focus 1): two
// accounts both have "cam1", each on its own cam-proxy and camera, and one
// person is in both. Every API route, called from each account's session,
// reaches only that account's proxy and camera, and the data-carrying
// answers differ. A camsId of the other account is unknown here.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { camKey } from '../server/fleet';
import { resetProxyClients } from '../server/proxy/client';
import { proxyHub, stopProxyStreams } from '../server/proxy/stream';
import { setReportedName, nameEvents } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetRebootCooldowns } from '../server/routes/settings';
import { FAKE_ADMIN_TOKEN, FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { ALPHA, BETA, applyFleet, cookieFor, restoreMode, twoAccounts } from './helpers/fleet';

const EVENT = '20260928-140000-140020';
const JOB = 'A'.repeat(22);
const M = Date.UTC(2026, 8, 28, 14, 0, 0);

// A camera stand-in that only counts: every request is answered 500.
interface Counter { url: string; hits: number; server: http.Server }
async function counter(): Promise<Counter> {
  const c = { hits: 0 } as Counter;
  c.server = http.createServer((_req, res) => {
    c.hits++;
    res.statusCode = 500;
    res.end();
  });
  await new Promise<void>((r) => c.server.listen(0, () => r()));
  c.url = `127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  return c;
}

let A: FakeProxy, B: FakeProxy, camA: Counter, camB: Counter;
beforeAll(async () => {
  [A, B, camA, camB] = await Promise.all([startFakeProxy(), startFakeProxy(), counter(), counter()]);
  A.publicUrl = 'https://alpha.example/';
  B.publicUrl = 'https://beta.example/';
  A.stills.set('cam1', new Map([[M + 1000, Buffer.concat([JPEG, Buffer.from('alpha')])]]));
  B.stills.set('cam1', new Map([[M + 2000, Buffer.concat([JPEG, Buffer.from('beta')])]]));
  A.archive.add('cam1', { createdAt: 1000, bytes: 10, name: 'alpha item' });
  B.archive.add('cam1', { createdAt: 2000, bytes: 20, name: 'beta item' });
});
afterAll(async () => {
  await Promise.all([A.stop(), B.stop(), new Promise((r) => camA.server.close(r)), new Promise((r) => camB.server.close(r))]);
});
beforeEach(() => {
  resetProxyClients();
  resetClients();
  resetRebootCooldowns();
  applyFleet(twoAccounts({ alphaUrl: A.url, betaUrl: B.url, alphaToken: FAKE_TOKEN, betaToken: FAKE_TOKEN, alphaHost: camA.url, betaHost: camB.url, betaRole: 'admin', adminToken: FAKE_ADMIN_TOKEN }));
});
afterEach(() => {
  stopProxyStreams();
  restoreMode();
  setCameras([]);
});

const SESSION = { alpha: cookieFor('both@example.org', ALPHA), beta: cookieFor('both@example.org', BETA) };
const ORIGIN = 'http://127.0.0.1';

interface Route { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; body?: (acc: string) => object; marker?: (r: request.Response) => unknown }
// Every /api route (server/routes; the access table of Task 6 lists the same),
// with :id = cam1, :via = cam1 and the other parameters from the fake proxies.
const ROUTES: Route[] = [
  { method: 'get', path: '/api/cameras', marker: (r) => JSON.stringify(r.body) },
  { method: 'get', path: '/api/cameras/cam1/status' },
  { method: 'get', path: '/api/cameras/cam1/snapshot.jpg' },
  { method: 'get', path: '/api/cameras/cam1/live' },
  { method: 'get', path: '/api/cameras/cam1/days?month=2026-09' },
  { method: 'get', path: '/api/cameras/cam1/extent' },
  { method: 'get', path: '/api/cameras/cam1/events?date=2026-09-28' },
  { method: 'get', path: `/api/cameras/cam1/clips/${EVENT}/video` },
  { method: 'get', path: `/api/cameras/cam1/clips/${EVENT}/thumb.jpg` },
  { method: 'get', path: `/api/cameras/cam1/clips/${EVENT}/download` },
  { method: 'get', path: `/api/cameras/cam1/clips/${EVENT}/full-quality` },
  { method: 'get', path: '/api/cameras/cam1/settings' },
  { method: 'put', path: '/api/cameras/cam1/settings/detection', body: () => ({ motionSensitivity: 30 }) },
  { method: 'get', path: '/api/cameras/cam1/device' },
  { method: 'get', path: '/api/cameras/cam1/light' },
  { method: 'put', path: '/api/cameras/cam1/light', body: () => ({ on: true }) },
  { method: 'post', path: '/api/cameras/cam1/reboot', body: () => ({ confirm: 'reboot' }) },
  { method: 'put', path: '/api/cameras/cam1/name', body: () => ({ name: 'Renamed' }) },
  { method: 'put', path: '/api/cameras/cam1/proxy', body: () => ({ enabled: true }) },
  { method: 'get', path: '/api/cameras/cam1/proxy/info', marker: (r) => r.body.webUrl },
  { method: 'post', path: '/api/cameras/cam1/proxy/login-link' },
  { method: 'get', path: `/api/cameras/cam1/previews?from=${M}&to=${M + 60_000}` },
  { method: 'get', path: `/api/cameras/cam1/stills?from=${M}&to=${M + 60_000}`, marker: (r) => JSON.stringify(r.body) },
  { method: 'get', path: `/api/cameras/cam1/stills/${M + 1000}.jpg` },
  { method: 'get', path: `/api/cameras/cam1/previews/${M}.jpg` },
  { method: 'get', path: '/api/cameras/cam1/still/latest.jpg' },
  { method: 'get', path: '/api/cameras/cam1/analyses/1' },
  { method: 'get', path: `/api/cameras/cam1/still-checks?from=${M}&to=${M + 60_000}` },
  { method: 'post', path: '/api/cameras/cam1/still-checks', body: () => ({ at: M + 1000 }) },
  { method: 'get', path: '/api/cameras/cam1/still-checks/1' },
  { method: 'get', path: '/api/cameras/cam1/analytics' },
  { method: 'post', path: '/api/cameras/cam1/compositions', body: () => ({ eventId: EVENT }) },
  { method: 'get', path: '/api/cameras/cam1/compositions/available' },
  { method: 'get', path: `/api/cameras/cam1/compositions/${JOB}` },
  { method: 'get', path: `/api/cameras/cam1/compositions/${JOB}/video` },
  { method: 'delete', path: `/api/cameras/cam1/compositions/${JOB}` },
  { method: 'post', path: '/api/cameras/cam1/archive', body: () => ({ source: { type: 'event', eventId: EVENT, quality: 'sub' } }) },
  { method: 'get', path: '/api/archive', marker: (r) => JSON.stringify(r.body.items?.map((i: { name: string }) => i.name)) },
  { method: 'get', path: '/api/archive/status' },
  { method: 'get', path: '/api/archive/cam1/items/1', marker: (r) => r.body.name },
  { method: 'patch', path: '/api/archive/cam1/items/1', body: () => ({ name: 'renamed' }) },
  { method: 'get', path: '/api/archive/cam1/items/1/video' },
  { method: 'get', path: '/api/archive/cam1/items/1/thumbnail' },
  { method: 'get', path: '/api/archive/cam1/items/1/metadata' },
  { method: 'get', path: '/api/archive/cam1/zip?ids=1' },
  { method: 'get', path: `/api/archive/cam1/jobs/${JOB}` },
  { method: 'delete', path: `/api/archive/cam1/jobs/${JOB}` },
  { method: 'post', path: '/api/archive/cam1/delete', body: () => ({ ids: [999] }) },
  { method: 'delete', path: '/api/archive/cam1/items/999' },
  { method: 'get', path: '/api/preferences' },
  { method: 'put', path: '/api/preferences', body: () => ({ lastCamera: 'cam1' }) },
  { method: 'get', path: '/api/me', marker: (r) => r.body.account?.id },
  { method: 'get', path: '/api/accounts' },
  { method: 'post', path: '/api/session/account', body: (acc) => ({ accountId: acc }) },
];
export const ISOLATION_ROUTES = ROUTES;

const settle = () => new Promise((r) => setTimeout(r, 60));
function hits() {
  return { proxyA: A.requests.length, proxyB: B.requests.length, camA: camA.hits, camB: camB.hits };
}
async function call(route: Route, who: 'alpha' | 'beta') {
  const acc = who === 'alpha' ? ALPHA : BETA;
  const before = hits();
  let req = request(createApp())[route.method](route.path).set('Cookie', SESSION[who]).set('Origin', ORIGIN).set('Host', '127.0.0.1');
  if (route.body) req = req.send(route.body(acc));
  const res = await req.timeout({ response: 5000, deadline: 8000 }).catch((e: { response?: request.Response }) => e.response ?? null);
  await settle();
  const after = hits();
  return { res, delta: { proxyA: after.proxyA - before.proxyA, proxyB: after.proxyB - before.proxyB, camA: after.camA - before.camA, camB: after.camB - before.camB } };
}

describe('every API route stays in the session\'s account', () => {
  for (const route of ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path.split('?')[0]}: each account reaches only its own proxy and camera`, async () => {
      const a = await call(route, 'alpha');
      const b = await call(route, 'beta');
      expect([route.path, a.delta.proxyB, a.delta.camB]).toEqual([route.path, 0, 0]); // Alpha's call never reached Beta's side
      expect([route.path, b.delta.proxyA, b.delta.camA]).toEqual([route.path, 0, 0]); // Beta's call never reached Alpha's side
      for (const r of [a.res, b.res]) {
        if (!r) continue;
        expect([route.path, r.body?.error]).not.toEqual([route.path, 'unknown_camera']);
        expect([route.path, r.body?.error]).not.toEqual([route.path, 'unknown_archive']);
        expect([route.path, r.body?.error]).not.toEqual([route.path, 'choose_account']);
      }
      if (route.marker) {
        expect(a.res && b.res).toBeTruthy();
        expect(route.marker(a.res!)).not.toEqual(route.marker(b.res!));
      }
    });
  }

  it('the route table covers both sides: some route reaches each proxy and each camera', async () => {
    const seen = { proxyA: 0, proxyB: 0, camA: 0, camB: 0 };
    for (const route of [ROUTES[1], ROUTES[22]]) {
      for (const who of ['alpha', 'beta'] as const) {
        const { delta } = await call(route, who);
        for (const k of Object.keys(seen) as (keyof typeof seen)[]) seen[k] += delta[k];
      }
    }
    expect(Object.values(seen).every((n) => n > 0)).toBe(true);
  });
});

describe('the other account\'s cameras', () => {
  it('a camsId of the other account answers 404 unknown_camera', async () => {
    applyFleet(twoAccounts({ alphaUrl: A.url, betaUrl: B.url, alphaToken: FAKE_TOKEN, betaToken: FAKE_TOKEN, alphaHost: camA.url, betaHost: camB.url, betaRole: 'admin',
      alphaExtra: [{ id: 'cam9', name: 'Nine', host: camA.url, protocol: 'http', user: 'u', password: 'p' }] }));
    const r = await request(createApp()).get('/api/cameras/cam9/status').set('Cookie', SESSION.beta);
    expect([r.status, r.body.error]).toEqual([404, 'unknown_camera']);
    const own = await request(createApp()).get('/api/cameras/cam9/status').set('Cookie', SESSION.alpha);
    expect(own.body.error).not.toBe('unknown_camera');
    const arch = await request(createApp()).get('/api/archive/cam9/items/1').set('Cookie', SESSION.beta);
    expect([arch.status, arch.body.error]).toEqual([404, 'unknown_archive']);
  });

  it('GET /api/cameras lists only the session\'s account, ids are camsIds', async () => {
    const a = await request(createApp()).get('/api/cameras').set('Cookie', SESSION.alpha);
    const b = await request(createApp()).get('/api/cameras').set('Cookie', SESSION.beta);
    expect(a.body.map((c: { id: string; name: string }) => [c.id, c.name])).toEqual([['cam1', 'Alpha cam']]);
    expect(b.body.map((c: { id: string; name: string }) => [c.id, c.name])).toEqual([['cam1', 'Beta cam']]);
    expect(JSON.stringify([a.body, b.body])).not.toContain('acc_');
  });

  it('preferences: the same email keeps its camera choice per account', async () => {
    await request(createApp()).put('/api/preferences').set('Cookie', SESSION.alpha).set('Origin', ORIGIN).set('Host', '127.0.0.1').send({ liveQuality: 'main' });
    expect((await request(createApp()).get('/api/preferences').set('Cookie', SESSION.beta)).body.liveQuality).toBe('sub');
    expect((await request(createApp()).get('/api/preferences').set('Cookie', SESSION.alpha)).body.liveQuality).toBe('main');
  });
});

describe('the browser relay (SSE)', () => {
  it('two sessions, one per account; an Alpha cam1 event reaches only the Alpha session, with cam = "cam1"', async () => {
    const server = http.createServer(createApp()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const frames = { alpha: [] as string[], beta: [] as string[] };
    const open = (who: 'alpha' | 'beta') =>
      new Promise<http.ClientRequest>((resolve) => {
        const req = http.get(`${base}/api/events/stream`, { headers: { Cookie: SESSION[who] } }, (res) => {
          res.setEncoding('utf8');
          res.on('data', (d: string) => frames[who].push(d));
          resolve(req);
        });
      });
    stopProxyStreams();
    const ra = await open('alpha'), rb = await open('beta');
    try {
      await new Promise((r) => setTimeout(r, 50));
      proxyHub.emit('message', { cam: camKey(ALPHA, 'cam1'), type: 'clip', data: { start: M } });
      proxyHub.emit('state', { cam: camKey(BETA, 'cam1'), up: true });
      setReportedName(camKey(ALPHA, 'cam1'), 'Alpha yard');
      proxyHub.emit('cameras', { accountId: BETA });
      await new Promise((r) => setTimeout(r, 100));
      const a = frames.alpha.join(''), b = frames.beta.join('');
      expect(a).toContain('event: change');
      expect(a).toContain('"cam":"cam1"');
      expect(a).toContain('Alpha yard');
      expect(a).not.toContain('event: proxy');
      expect(a).not.toContain('event: cameras');
      expect(b).not.toContain('event: change');
      expect(b).not.toContain('Alpha yard');
      expect(b).toContain('event: proxy');
      expect(b).toContain('event: cameras');
      expect(a + b).not.toContain('acc_');
    } finally {
      ra.destroy();
      rb.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      void nameEvents;
    }
  });
});
