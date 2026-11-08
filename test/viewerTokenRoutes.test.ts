// Viewer token sign-in, the cams side (cams-admin design
// docs/superpowers/specs/2026-11-05-viewer-tokens-design.md §9.2–9.8):
// POST /auth/viewer-token/check and /auth/viewer-token, the session that
// follows the fleet on every request, the picker for a token with two
// accounts, /api/me, MCP tokens refused, the /token page, the limits, the
// Pi's login token alongside, and no token or fingerprint in any log line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import jwt from 'jsonwebtoken';
import { inspect } from 'util';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { setFleet, type FleetAccount } from '../server/fleet';
import { logger } from '../server/logger';
import { resetRateLimits } from '../server/middleware/rateLimit';
import { SESSION_COOKIE, verifySession } from '../server/session';
import { sessionTag, setViewerTokenClock, takeViewerTokenUses, viewerTokenFingerprint } from '../server/viewerTokens';
import { ALPHA, BETA, applyFleet, restoreMode, twoAccounts } from './helpers/fleet';

const HOUR = 3_600_000;
const TOKEN = 'cav_RouteTestFakeToken0001';
const TWO = 'cav_RouteTestFakeToken0002';
const OLD = 'cav_RouteTestFakeToken0003';
const ID = 'vtk_0000000000000000000A';
const ID_TWO = 'vtk_0000000000000000000B';
const ID_OLD = 'vtk_0000000000000000000C';
const ORIGIN = 'http://127.0.0.1';
const grant = (id: string, token: string, expiresAt: number, name: string) => ({ id, name, fingerprint: viewerTokenFingerprint(token), expiresAt });

let now: number;
let clock: { adminNow: number; lastGoodAt: number | null };
function fleet(o: { tokenExpires?: number; withToken?: boolean } = {}): FleetAccount[] {
  const [alpha, beta] = twoAccounts();
  alpha.viewerTokens = [
    ...(o.withToken === false ? [] : [grant(ID, TOKEN, o.tokenExpires ?? now + 7 * 24 * HOUR, 'Kitchen tablet')]),
    grant(ID_TWO, TWO, now + 24 * HOUR, 'Both'),
    grant(ID_OLD, OLD, now - 1000, 'Old'),
  ];
  beta.viewerTokens = [grant(ID_TWO, TWO, now + 24 * HOUR, 'Both')];
  return [alpha, beta];
}

const post = (path: string, body: unknown, cookie = '') => {
  const r = request(createApp()).post(path).set('Origin', ORIGIN).set('Host', '127.0.0.1');
  if (cookie) r.set('Cookie', cookie);
  return r.send(body as object);
};
const sessionCookie = (res: request.Response) => (res.get('Set-Cookie') ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
const cookieOf = (res: request.Response) => sessionCookie(res)!.split(';')[0];

beforeEach(() => {
  now = Date.now();
  clock = { adminNow: now, lastGoodAt: now - 60_000 };
  setViewerTokenClock({ now: () => now, adminNow: () => clock.adminNow, lastGoodAt: () => clock.lastGoodAt, enabled: () => process.env.CONFIG_SOURCE === 'cams-admin' });
  applyFleet(fleet());
  resetRateLimits();
  takeViewerTokenUses();
});
afterEach(() => {
  setViewerTokenClock(null);
  restoreMode();
  setFleet([]);
  setCameras([]);
  vi.restoreAllMocks();
  delete process.env.RATE_LIMIT_TOKEN_FAILURES;
  delete process.env.RATE_LIMIT_VIEWER_TOKEN_FAILURES;
});

describe('POST /auth/viewer-token/check', () => {
  it('a valid token: its name and expiry only, no session', async () => {
    const r = await post('/auth/viewer-token/check', { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ name: 'Kitchen tablet', expiresAt: now + 7 * 24 * HOUR });
    expect(sessionCookie(r)).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('unknown, expired, revoked, malformed, 24 h offline, file mode: the one answer 401 invalid_token', async () => {
    const answers: unknown[] = [];
    for (const token of ['cav_RouteTestFakeToken9999', OLD, 'nope', 42, undefined]) answers.push((await post('/auth/viewer-token/check', { token })).body);
    applyFleet(fleet({ withToken: false })); // revoked
    answers.push((await post('/auth/viewer-token/check', { token: TOKEN })).body);
    applyFleet(fleet());
    clock.lastGoodAt = now - 24 * HOUR - 1;
    answers.push((await post('/auth/viewer-token/check', { token: TOKEN })).body);
    clock.lastGoodAt = now;
    restoreMode(); // file mode
    answers.push((await post('/auth/viewer-token/check', { token: TOKEN })).body);
    expect(answers).toEqual(Array(8).fill({ error: 'invalid_token' }));
  });

  it('the token in the query is refused (400 token_in_url) and never read; a form post 415; cross-site 403', async () => {
    for (const q of ['t', 'token']) {
      const r = await post(`/auth/viewer-token/check?${q}=${TOKEN}`, { token: TOKEN });
      expect([r.status, r.body]).toEqual([400, { error: 'token_in_url' }]);
    }
    const form = await request(createApp()).post('/auth/viewer-token').set('Origin', ORIGIN).set('Host', '127.0.0.1').type('form').send({ token: TOKEN });
    expect(form.status).toBe(415);
    expect(sessionCookie(form)).toBeUndefined();
    const cross = await request(createApp()).post('/auth/viewer-token').set('Origin', 'https://evil.example').set('Host', '127.0.0.1').send({ token: TOKEN });
    expect(cross.status).toBe(403);
    expect(sessionCookie(cross)).toBeUndefined();
  });
});

describe('POST /auth/viewer-token', () => {
  it('signs in as a viewer of the token\'s account until the token expires', async () => {
    const r = await post('/auth/viewer-token', { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ redirect: '/app/video' });
    const set = sessionCookie(r)!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(set)![1]);
    expect(Math.abs(maxAge - 7 * 24 * 3600)).toBeLessThanOrEqual(2);
    const raw = cookieOf(r).slice(SESSION_COOKIE.length + 1);
    expect(verifySession(raw)).toEqual({ email: `viewer-token:${ID}`, via: 'viewer-token', vt: ID, tf: sessionTag(viewerTokenFingerprint(TOKEN)), acc: ALPHA });
    expect((jwt.decode(raw) as { exp: number }).exp).toBe(Math.floor((now + 7 * 24 * HOUR) / 1000));
    expect(raw).not.toContain(TOKEN);
    const me = await request(createApp()).get('/api/me').set('Cookie', cookieOf(r));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: `viewer-token:${ID}`, via: 'viewer-token', name: 'Kitchen tablet', validUntil: now + 7 * 24 * HOUR, role: 'viewer', account: { id: ALPHA }, accounts: 1 });
  });

  it('a viewer: reads, but an admin route is refused; no MCP token can be made from it', async () => {
    const c = cookieOf(await post('/auth/viewer-token', { token: TOKEN }));
    expect((await request(createApp()).get('/api/cameras').set('Cookie', c)).body.map((x: { name: string }) => x.name)).toEqual(['Alpha cam']);
    const rename = await request(createApp()).put('/api/cameras/cam1/name').set('Cookie', c).set('Origin', ORIGIN).set('Host', '127.0.0.1').send({ name: 'Hacked' });
    expect(rename.status).toBe(403);
    const mcp = await post('/api/mcp-tokens', { name: 'x', days: 7 }, c);
    expect([mcp.status, mcp.body]).toEqual([403, { error: 'forbidden_viewer_token' }]);
  });

  it('the session ends after the fleet drops the token (a revoke, the next pull), a shorter validity, the expiry, 24 h offline', async () => {
    const c = cookieOf(await post('/auth/viewer-token', { token: TOKEN }));
    const me = () => request(createApp()).get('/api/me').set('Cookie', c).then((r) => r.status);
    expect(await me()).toBe(200);
    applyFleet(fleet({ withToken: false })); // revoked: the pulled snapshot no longer lists it
    expect(await me()).toBe(401);
    applyFleet(fleet({ tokenExpires: now + HOUR })); // valid again, but shorter
    expect(await me()).toBe(200);
    clock.adminNow = now + HOUR;
    expect(await me()).toBe(401);
    clock.adminNow = now;
    clock.lastGoodAt = now - 25 * HOUR;
    expect(await me()).toBe(401);
    // a page visit with that cookie: signed out, to the token page
    const page = await request(createApp()).get('/app/video').set('Cookie', c);
    expect([page.status, page.headers.location]).toEqual([302, '/token']);
  });

  it('an ended session\'s renewal goes to /token, not Google', async () => {
    const c = cookieOf(await post('/auth/viewer-token', { token: TOKEN }));
    applyFleet(fleet({ withToken: false }));
    const r = await request(createApp()).get('/auth/google/login?silent=1&returnTo=/app/video').set('Cookie', c);
    expect([r.status, r.headers.location]).toEqual([302, '/token']);
  });

  it('two accounts: the picker, then a viewer token session in the chosen account (re-signed, same expiry)', async () => {
    const r = await post('/auth/viewer-token', { token: TWO });
    expect(r.body).toEqual({ redirect: '/app/accounts' });
    const c = cookieOf(r);
    expect((await request(createApp()).get('/api/cameras').set('Cookie', c)).status).toBe(409);
    const me = await request(createApp()).get('/api/me').set('Cookie', c);
    expect(me.body).toMatchObject({ via: 'viewer-token', name: 'Both', accounts: 2, account: null });
    const list = await request(createApp()).get('/api/accounts').set('Cookie', c);
    expect(list.body.items.map((i: { id: string; role: string }) => [i.id, i.role])).toEqual([[ALPHA, 'viewer'], [BETA, 'viewer']]);
    const pick = await post('/api/session/account', { accountId: BETA }, c);
    expect(pick.status).toBe(200);
    const raw = cookieOf(pick).slice(SESSION_COOKIE.length + 1);
    expect(verifySession(raw)).toMatchObject({ via: 'viewer-token', vt: ID_TWO, acc: BETA });
    expect((jwt.decode(raw) as { exp: number }).exp).toBe(Math.floor((now + 24 * HOUR) / 1000));
    const cams = await request(createApp()).get('/api/cameras').set('Cookie', cookieOf(pick));
    expect(cams.body.map((x: { name: string }) => x.name)).toEqual(['Beta cam']);
    // an account the token doesn't have
    expect((await post('/api/session/account', { accountId: 'acc_NOTANACCOUNTNOTANACC' }, c)).status).toBe(404);
  });

  it('a session still naming an account the token lost: signed out', async () => {
    const pick = await post('/api/session/account', { accountId: BETA }, cookieOf(await post('/auth/viewer-token', { token: TWO })));
    const c = cookieOf(pick);
    const [alpha, beta] = fleet();
    beta.viewerTokens = [];
    applyFleet([alpha, beta]);
    expect((await request(createApp()).get('/api/me').set('Cookie', c)).status).toBe(401);
  });

  it('a forged session (another tag, another id, a token id without the matching email) is nobody', async () => {
    const forge = (p: Record<string, unknown>) => `${SESSION_COOKIE}=${jwt.sign(p, process.env.COOKIE_SECRET!, { expiresIn: '1h' })}`;
    for (const p of [
      { email: `viewer-token:${ID}`, via: 'viewer-token', vt: ID, tf: '0'.repeat(16) },
      { email: `viewer-token:${ID_OLD}`, via: 'viewer-token', vt: ID_OLD, tf: sessionTag(viewerTokenFingerprint(OLD)) },
      { email: 'klaus@klaushofrichter.net', via: 'viewer-token', vt: ID, tf: sessionTag(viewerTokenFingerprint(TOKEN)) },
    ]) expect((await request(createApp()).get('/api/me').set('Cookie', forge(p))).status).toBe(401);
  });

  it('a use is noted for the report (minute, id only)', async () => {
    const c = cookieOf(await post('/auth/viewer-token', { token: TOKEN }));
    takeViewerTokenUses();
    await request(createApp()).get('/api/me').set('Cookie', c);
    expect(takeViewerTokenUses()).toEqual([{ id: ID, lastUsedAt: Math.floor(now / 60_000) * 60_000 }]);
  });
});

// Spec A4: a viewer token with role "admin" is an admin of its accounts
// (Confirm held items, settings), like a Google admin there; absent = viewer.
describe('an admin viewer token', () => {
  const ADMIN = 'cav_RouteTestFakeToken0004';
  const ID_ADMIN = 'vtk_0000000000000000000D';
  const withAdmin = (alphaRole: 'admin' | 'viewer' | undefined, betaRole?: 'admin' | 'viewer') => {
    const [alpha, beta] = fleet();
    const g = grant(ID_ADMIN, ADMIN, now + 24 * HOUR, 'Ops tablet');
    alpha.viewerTokens = [...alpha.viewerTokens!, { ...g, ...(alphaRole && { role: alphaRole }) }];
    if (betaRole) beta.viewerTokens = [...beta.viewerTokens!, { ...g, role: betaRole }];
    return [alpha, beta];
  };

  it('signs in as an admin: /api/me says so, admin routes answer; still no MCP token', async () => {
    applyFleet(withAdmin('admin'));
    const c = cookieOf(await post('/auth/viewer-token', { token: ADMIN }));
    const me = await request(createApp()).get('/api/me').set('Cookie', c);
    expect(me.body).toMatchObject({ via: 'viewer-token', name: 'Ops tablet', role: 'admin', account: { id: ALPHA } });
    expect((await request(createApp()).get('/api/admin/held').set('Cookie', c)).status).toBe(200);
    const mcp = await post('/api/mcp-tokens', { name: 'x', days: 7 }, c);
    expect([mcp.status, mcp.body]).toEqual([403, { error: 'forbidden_viewer_token' }]);
  });

  it('role "viewer" or absent: a viewer (admin routes refused)', async () => {
    for (const role of ['viewer', undefined] as const) {
      applyFleet(withAdmin(role));
      const c = cookieOf(await post('/auth/viewer-token', { token: ADMIN }));
      expect((await request(createApp()).get('/api/me').set('Cookie', c)).body.role).toBe('viewer');
      expect((await request(createApp()).get('/api/admin/held').set('Cookie', c)).status).toBe(403);
    }
  });

  it('per account: admin in one, viewer in the other (the picker shows each)', async () => {
    applyFleet(withAdmin('admin', 'viewer'));
    const c = cookieOf(await post('/auth/viewer-token', { token: ADMIN }));
    const list = await request(createApp()).get('/api/accounts').set('Cookie', c);
    expect(list.body.items.map((i: { id: string; role: string }) => [i.id, i.role])).toEqual([[ALPHA, 'admin'], [BETA, 'viewer']]);
    const beta = cookieOf(await post('/api/session/account', { accountId: BETA }, c));
    expect((await request(createApp()).get('/api/me').set('Cookie', beta)).body.role).toBe('viewer');
  });

  it('follows the fleet on every request: admin taken away, the next request is a viewer', async () => {
    applyFleet(withAdmin('admin'));
    const c = cookieOf(await post('/auth/viewer-token', { token: ADMIN }));
    expect((await request(createApp()).get('/api/admin/held').set('Cookie', c)).status).toBe(200);
    applyFleet(withAdmin('viewer'));
    expect((await request(createApp()).get('/api/admin/held').set('Cookie', c)).status).toBe(403);
  });
});

describe('limits', () => {
  it('per address: failures count (10 by default), a success doesn\'t; then 429 too_many_attempts for the right token too', async () => {
    process.env.RATE_LIMIT_TOKEN_FAILURES = '3';
    resetRateLimits();
    expect((await post('/auth/viewer-token', { token: TOKEN })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await post('/auth/viewer-token/check', { token: 'cav_RouteTestFakeToken9999' })).status).toBe(401);
    const r = await post('/auth/viewer-token', { token: TOKEN });
    expect([r.status, r.body]).toEqual([429, { error: 'too_many_attempts' }]);
  });

  it('one bucket for all addresses (100 by default)', async () => {
    process.env.RATE_LIMIT_TOKEN_FAILURES = '1000';
    process.env.RATE_LIMIT_VIEWER_TOKEN_FAILURES = '2';
    resetRateLimits();
    for (let i = 0; i < 2; i++) expect((await post('/auth/viewer-token', { token: 'nope' })).status).toBe(401);
    expect((await post('/auth/viewer-token/check', { token: TOKEN })).status).toBe(429);
  });

  it('a body over 4 KiB: 413', async () => {
    const r = await post('/auth/viewer-token', { token: TOKEN, pad: 'x'.repeat(5000) });
    expect(r.status).toBe(413);
  });
});

describe('the Pi\'s login token alongside', () => {
  it('keeps working in cams-admin mode, also 24 h without cams-admin', async () => {
    process.env.CAMS_LOGIN_TOKEN = 'a-long-enough-pi-token-for-the-test-0001';
    process.env.CAMS_TOKEN_ACCOUNT = 'alpha';
    try {
      clock.lastGoodAt = now - 48 * HOUR;
      const r = await post('/auth/token', { token: 'a-long-enough-pi-token-for-the-test-0001' });
      expect(r.status).toBe(200);
      const me = await request(createApp()).get('/api/me').set('Cookie', cookieOf(r));
      expect(me.body).toMatchObject({ via: 'token', role: 'admin', account: { id: ALPHA } });
      expect((await post('/auth/viewer-token', { token: TOKEN })).status).toBe(401); // the viewer tokens are off meanwhile
    } finally {
      delete process.env.CAMS_LOGIN_TOKEN;
      delete process.env.CAMS_TOKEN_ACCOUNT;
    }
  });
});

describe('the /token page', () => {
  beforeEach(() => {
    process.env.WEB_DIST = resolve(__dirname, 'fixtures/web');
  });
  afterEach(() => {
    delete process.env.WEB_DIST;
  });

  it('is the start bundle, no referrer, no cache, "viewer-token" in cams-login (cams-admin mode only)', async () => {
    const r = await request(createApp()).get('/token');
    expect(r.status).toBe(200);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.text).toMatch(/<meta name="cams-login" content="google viewer-token" \/>/);
    restoreMode();
    expect((await request(createApp()).get('/signin')).text).toMatch(/<meta name="cams-login" content="google" \/>/);
  });

  it('web/index.html takes the fragment out of the address before any module script runs', () => {
    const html = readFileSync(resolve(__dirname, '../web/index.html'), 'utf8');
    const take = html.indexOf("history.replaceState(null, '', '/token')");
    expect(take).toBeGreaterThan(0);
    expect(take).toBeLessThan(html.indexOf('<script type="module"'));
  });

  it('a token in the query: 400, never read', async () => {
    for (const q of ['t', 'token']) {
      const r = await request(createApp()).get(`/token?${q}=${TOKEN}`);
      expect(r.status).toBe(400);
      expect(r.text).not.toContain(TOKEN);
    }
  });
});

describe('logs', () => {
  it('never the token or its fingerprint: viewer_token_login with the id, failures with a reason', async () => {
    const lines: string[] = [];
    // The app's own lines (pino-http's request lines pass the raw request to
    // pino, whose serializers drop it: test/logger.test.ts covers those).
    for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => void (a.at(-1) !== 'api_request' && lines.push(inspect(a, { depth: 6 })))) as never);
    await post('/auth/viewer-token/check', { token: TOKEN });
    await post('/auth/viewer-token', { token: TOKEN });
    await post('/auth/viewer-token', { token: OLD });
    await post('/auth/viewer-token', { token: 'cav_RouteTestFakeToken9999' });
    const all = lines.join('\n');
    expect(all).toContain('viewer_token_login');
    expect(all).toContain(ID);
    expect(all).toContain('viewer_token_login_failed');
    for (const secret of [TOKEN, OLD, 'cav_RouteTestFakeToken9999', viewerTokenFingerprint(TOKEN).slice(7), sessionTag(viewerTokenFingerprint(TOKEN))]) expect(all).not.toContain(secret);
  });
});
