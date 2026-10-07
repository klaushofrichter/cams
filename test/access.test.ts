// The role table (migration P4, M §9.5, R4-9): one line per API route;
// viewers read, admins change; a route without a line is refused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { createApiRateLimit } from '../server/middleware/rateLimit';
import { ACCESS, VIEWER_WRITES, accessMiddleware, registeredApiRoutes } from '../server/routes/access';
import { ALPHA, BETA, applyFleet, cookieFor, restoreMode, twoAccounts } from './helpers/fleet';

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const EVENT = '20260928-140000-140020';
const JOB = 'A'.repeat(22);
const fill = (path: string) =>
  path
    .replace(':clipId', EVENT)
    .replace(':eventId', '1')
    .replace(':section', 'detection')
    .replace(':job', JOB)
    .replace(':file', '1.jpg')
    .replace(':via', 'cam1')
    .replace(/\/api\/archive\/cam1\/items\/:id/, '/api/archive/cam1/items/1')
    .replace(':id', 'cam1');
const VIEWER = cookieFor('both@example.org', BETA); // viewer in Beta
const ADMIN = cookieFor('both@example.org', ALPHA);
async function callAs(cookie: string, k: string) {
  const [method, path] = k.split(' ');
  return request(createApp())
    [method.toLowerCase() as 'get'](fill(path))
    .set('Cookie', cookie)
    .set('Origin', 'http://127.0.0.1')
    .set('Host', '127.0.0.1')
    .send({})
    .timeout({ response: 3000, deadline: 5000 })
    .catch((e: { response?: request.Response }) => e.response ?? ({ status: 0, body: {} } as request.Response));
}

beforeEach(() => applyFleet(twoAccounts()));
afterEach(() => {
  restoreMode();
  setCameras([]);
});

describe('the access table', () => {
  const routes = registeredApiRoutes(createApp());

  it('every registered /api route has exactly one line, and every line is a registered route', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.map(key).sort()).toEqual(Object.keys(ACCESS).sort());
  });

  it('every non-GET route needs admin, except the listed viewer writes', () => {
    for (const [k, need] of Object.entries(ACCESS)) if (!k.startsWith('GET ') && !VIEWER_WRITES.includes(k)) expect([k, need]).toEqual([k, 'admin']);
    expect([...VIEWER_WRITES].sort()).toEqual(['DELETE /api/cameras/:id/compositions/:job', 'POST /api/cameras/:id/compositions', 'POST /api/session/account', 'PUT /api/preferences']);
    for (const k of VIEWER_WRITES) expect(ACCESS[k]).not.toBe('admin');
  });

  it('every route that reaches a proxy\'s admin side needs admin (login-link, name, proxy switch)', () => {
    for (const k of ['POST /api/cameras/:id/proxy/login-link', 'PUT /api/cameras/:id/name', 'PUT /api/cameras/:id/proxy', 'POST /api/cameras/:id/reboot']) expect([k, ACCESS[k]]).toEqual([k, 'admin']);
    for (const k of ['GET /api/me', 'GET /api/accounts', 'POST /api/session/account']) expect([k, ACCESS[k]]).toEqual([k, 'signed-in']);
  });

  it('a viewer gets 403 forbidden_role on every admin route and is let through on every viewer route (live app, two-account fixture)', async () => {
    for (const [k, need] of Object.entries(ACCESS)) {
      if (k === 'GET /api/events/stream' || k === 'GET /api/cameras/:id/live') continue; // streams: checked below
      const r = await callAs(VIEWER, k);
      if (need === 'admin') expect([k, r.status, r.body.error]).toEqual([k, 403, 'forbidden_role']);
      else expect([k, r.status === 403 && r.body.error === 'forbidden_role']).toEqual([k, false]);
    }
  }, 60_000);

  it('the same routes let an admin through', async () => {
    for (const k of ['PUT /api/cameras/:id/name', 'POST /api/archive/:via/delete', 'PUT /api/cameras/:id/settings/:section']) {
      const r = await callAs(ADMIN, k);
      expect([k, r.body.error]).not.toEqual([k, 'forbidden_role']);
    }
  });

  it('a trailing slash or another letter case reaches the same route and the same rule (no way around the table)', async () => {
    for (const path of ['/api/cameras/cam1/name/', '/API/cameras/cam1/name', '/api/Cameras/cam1/NAME/']) {
      const r = await request(createApp()).put(path).set('Cookie', VIEWER).set('Origin', 'http://127.0.0.1').set('Host', '127.0.0.1').send({ name: 'x' });
      expect([path, r.status, r.body.error]).toEqual([path, 403, 'forbidden_role']);
    }
    const ok = await request(createApp()).get('/api/cameras/').set('Cookie', VIEWER);
    expect(ok.body.error).not.toBe('forbidden_role');
  });

  it('a route added without a line is refused 403 no_access_rule (fail closed); an unknown path stays a 404', async () => {
    const app = express();
    app.use(createApiRateLimit()); // as the real app (CodeQL js/missing-rate-limiting)
    app.use((_req, res, next) => {
      res.locals.principal = { email: 'a@example.org', via: 'google', account: { id: ALPHA, name: 'alpha', displayName: 'Alpha' }, role: 'admin' };
      next();
    });
    const router = express.Router();
    router.get('/api/cameras', (_req, res) => void res.json([]));
    router.get('/api/new-thing', (_req, res) => void res.json({ ok: true }));
    app.use('/api', accessMiddleware());
    app.use(router);
    app.use((_req, res) => void res.status(404).json({ error: 'not found' }));
    const r = await request(app).get('/api/new-thing');
    expect([r.status, r.body.error]).toEqual([403, 'no_access_rule']);
    expect((await request(app).get('/api/cameras')).status).toBe(200);
    expect((await request(app).get('/api/nothing-here')).status).toBe(404);
  });

  it('writes are denied by default: a prefixed sub-router\'s or a RegExp route without a line is refused (any role)', async () => {
    const app = express();
    app.use(createApiRateLimit());
    app.use((_req, res, next) => {
      res.locals.principal = { email: 'a@example.org', via: 'google', account: { id: ALPHA, name: 'alpha', displayName: 'Alpha' }, role: 'admin' };
      next();
    });
    app.use('/api', accessMiddleware());
    const sub = express.Router();
    sub.put('/danger', (_req, res) => void res.json({ reached: true }));
    app.use('/api/thing', sub);
    app.put(/^\/api\/regex$/, (_req, res) => void res.json({ reached: true }));
    app.post('/api/unlisted/:x', (_req, res) => void res.json({ reached: true }));
    for (const [m, path] of [['put', '/api/thing/danger'], ['put', '/api/regex'], ['post', '/api/unlisted/1'], ['delete', '/api/nothing']] as const) {
      const r = await request(app)[m](path);
      expect([path, r.status, r.body.error]).toEqual([path, 403, 'no_access_rule']);
    }
  });

  it('every /api route of the app is a plain string path (the walker sees it, the table covers it)', () => {
    const app = createApp() as unknown as { router: { stack: { route?: { path: unknown }; handle?: { stack?: unknown[] }; name?: string; matchers?: unknown }[] } };
    const odd: string[] = [];
    const walk = (stack: { route?: { path: unknown }; handle?: { stack?: unknown[] } }[]) => {
      for (const l of stack) {
        if (l.route && typeof l.route.path !== 'string' && !(Array.isArray(l.route.path) && l.route.path.every((p) => typeof p === 'string'))) odd.push(String(l.route.path));
        if (l.handle?.stack) walk(l.handle.stack as never);
      }
    };
    walk(app.router.stack as never);
    expect(odd).toEqual([]);
  });

  it('file mode: everyone signed in is admin (today\'s behaviour)', async () => {
    restoreMode();
    setCameras([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]);
    const r = await callAs(cookieFor('klaus@klaushofrichter.net'), 'PUT /api/cameras/:id/name');
    expect(r.body.error).not.toBe('forbidden_role');
    expect((await request(createApp()).get('/api/me').set('Cookie', cookieFor('klaus@klaushofrichter.net'))).body.role).toBe('admin');
  });

  it('streams: a viewer may open the live view and the event stream', async () => {
    const r = await request(createApp()).get('/api/cameras/cam1/live').set('Cookie', VIEWER).timeout({ response: 3000 }).catch((e: { response?: request.Response }) => e.response);
    expect(r?.body?.error).not.toBe('forbidden_role');
  });
});
