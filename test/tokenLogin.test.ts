import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { resolve } from 'path';

// Wrapped, not replaced: the tests check that the comparison goes through
// timingSafeEqual with two digests of equal length.
const timing = vi.hoisted(() => ({ calls: [] as [number, number][] }));
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timing.calls.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { createApp } from '../server/app';
import { SESSION_COOKIE, signSession } from '../server/session';
import { currentUser } from '../server/middleware/requireAuth';
import type { Request } from 'express';

const TOKEN = 'demo-kit-token-0123456789abcdef';
const NAMES = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'ALLOWED_EMAILS', 'COOKIE_SECURE', 'CAMS_LOGIN_TOKEN', 'CAMS_LOGIN_TOKEN_FILE', 'CAMS_TOKEN_USER', 'RATE_LIMIT_TOKEN_FAILURES'] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.WEB_DIST = resolve(__dirname, 'fixtures/web');
});
afterAll(() => {
  delete process.env.WEB_DIST;
});
beforeEach(() => {
  for (const n of NAMES) saved[n] = process.env[n];
  process.env.CAMS_LOGIN_TOKEN = TOKEN;
  timing.calls = [];
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

function tokenOnly(): void {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;
  delete process.env.ALLOWED_EMAILS;
}

const cookies = (res: request.Response): string[] => {
  const raw = res.get('Set-Cookie');
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
};
const sessionCookie = (res: request.Response): string | undefined => cookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
const sessionValue = (res: request.Response): string => sessionCookie(res)!.split(';')[0].slice(SESSION_COOKIE.length + 1);

function post(app = createApp(), body: unknown = { token: TOKEN }) {
  return request(app).post('/auth/token').send(body as object);
}

// What currentUser() decides for a request carrying this session cookie.
function userFor(value: string) {
  return currentUser({ cookies: { [SESSION_COOKIE]: value } } as unknown as Request);
}

describe('POST /auth/token', () => {
  it('signs in with the right token (JSON): the session cookie, and where to go', async () => {
    tokenOnly();
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ redirect: '/app/video' });
    const cookie = sessionCookie(res)!;
    expect(cookie).toMatch(/Max-Age=604800/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/);
    const payload = jwt.decode(sessionValue(res)) as Record<string, unknown>;
    expect(payload).toMatchObject({ email: 'local', via: 'token' });
    expect(payload.tf).toMatch(/^[0-9a-f]{16}$/);
    // The session works on the API like a Google one.
    const me = await request(createApp()).get('/api/me').set('Cookie', `${SESSION_COOKIE}=${sessionValue(res)}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('local');
  });

  it('accepts a form post and answers with a 303', async () => {
    tokenOnly();
    const res = await request(createApp()).post('/auth/token').type('form').send({ token: TOKEN });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(sessionCookie(res)).toBeDefined();
  });

  it('a wrong form post goes back to the start page with login=failed', async () => {
    tokenOnly();
    const res = await request(createApp()).post('/auth/token').type('form').send({ token: 'wrong' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/?login=failed');
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('refuses a wrong, missing, short, oversized or non-string token', async () => {
    tokenOnly();
    const app = createApp();
    for (const body of [{ token: 'wrong-token-but-long-enough-000000' }, {}, { token: '' }, { token: TOKEN.slice(0, -1) }, { token: `${TOKEN}x` }, { token: 'x'.repeat(5000) }, { token: [TOKEN] }, { token: 12345 }]) {
      const res = await post(app, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_token' });
      expect(sessionCookie(res)).toBeUndefined();
    }
  });

  it('compares SHA-256 digests with timingSafeEqual (equal lengths, whatever was sent)', async () => {
    tokenOnly();
    await post(createApp(), { token: 'x' });
    await post(createApp(), { token: TOKEN });
    expect(timing.calls).toEqual([
      [32, 32],
      [32, 32],
    ]);
  });

  it('never takes the token from the URL', async () => {
    tokenOnly();
    const res = await request(createApp()).post(`/auth/token?token=${TOKEN}`).send({ token: TOKEN });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'token_in_url' });
    expect(sessionCookie(res)).toBeUndefined();
    const get = await request(createApp()).get(`/auth/token?token=${TOKEN}`);
    expect(get.status).toBe(404);
  });

  it('refuses a cross-origin post (CSRF)', async () => {
    tokenOnly();
    const res = await request(createApp()).post('/auth/token').set('Origin', 'https://evil.example').send({ token: TOKEN });
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('with token login off, is exactly an unknown route (no limiter, no JSON of its own)', async () => {
    delete process.env.CAMS_LOGIN_TOKEN;
    const app = createApp();
    const res = await post(app);
    const unknown = await request(app).post('/auth/no-such-route').send({ token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.status).toBe(unknown.status);
    expect(res.text).toBe(unknown.text);
    expect(res.headers['content-type']).toBe(unknown.headers['content-type']);
    // Not behind the auth or failure limiters either: the same limiter as any unknown path.
    expect(res.headers['ratelimit-policy']).toBe(unknown.headers['ratelimit-policy']);
  });

  it('cross-site posts never use up the failure budget', async () => {
    tokenOnly();
    const app = createApp();
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post('/auth/token').set('Origin', 'https://evil.example').send({ token: 'nope' });
      expect(res.status).toBe(403);
    }
    for (let i = 0; i < 9; i++) expect((await post(app, { token: 'nope' })).status).toBe(401);
    expect((await post(app)).status).toBe(200);
  });

  it('stops an address after 10 failures, but not after successes', async () => {
    tokenOnly();
    const app = createApp();
    for (let i = 0; i < 12; i++) expect((await post(app)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await post(app, { token: 'nope' })).status).toBe(401);
    const blocked = await post(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'too_many_attempts' });
  });

  it('is behind the auth rate limiter too', async () => {
    tokenOnly();
    const app = createApp();
    let last = 0;
    for (let i = 0; i < 41; i++) last = (await post(app)).status;
    expect(last).toBe(429);
  });

  it('goes to the remembered return_to page (#155 rules), and forgets it', async () => {
    tokenOnly();
    const res = await post().set('Cookie', 'return_to=%2Fapp%2Ftimeline%3Fcam%3Dcam1');
    expect(res.body).toEqual({ redirect: '/app/timeline?cam=cam1' });
    expect(cookies(res).join(';')).toMatch(/return_to=;/);
    const unsafe = await post().set('Cookie', 'return_to=%2F%2Fevil.example');
    expect(unsafe.body).toEqual({ redirect: '/app/video' });
  });

  it('clears login_hint, so no silent Google renewal follows', async () => {
    const res = await post().set('Cookie', 'login_hint=klaus%40klaushofrichter.net');
    expect(res.status).toBe(200);
    expect(cookies(res).join(';')).toMatch(/login_hint=;/);
  });
});

describe('COOKIE_SECURE', () => {
  it('false: the session cookie works over http (no Secure), and no HSTS', async () => {
    tokenOnly();
    process.env.COOKIE_SECURE = 'false';
    const res = await post();
    expect(sessionCookie(res)).not.toMatch(/Secure/);
    expect(sessionCookie(res)).toMatch(/HttpOnly/);
    expect(res.headers['strict-transport-security']).toBeUndefined();
    const page = await request(createApp()).get('/?returnTo=/app/live');
    expect(page.headers['strict-transport-security']).toBeUndefined();
    expect(cookies(page).join(';')).toMatch(/return_to=/);
    expect(cookies(page).join(';')).not.toMatch(/Secure/);
  });

  it('false applies to Google cookies too; true keeps Secure everywhere', async () => {
    process.env.COOKIE_SECURE = 'false';
    const off = await request(createApp()).get('/auth/google/login?returnTo=/app/live');
    expect(cookies(off).join(';')).not.toMatch(/Secure/);
    process.env.COOKIE_SECURE = 'true';
    const on = await request(createApp()).get('/auth/google/login?returnTo=/app/live');
    for (const c of cookies(on)) expect(c).toMatch(/Secure/);
    const logout = await request(createApp()).get('/auth/logout');
    for (const c of cookies(logout)) expect(c).toMatch(/Secure/);
  });
});

describe('who a token session is', () => {
  it('bypasses ALLOWED_EMAILS for the token user only', async () => {
    process.env.ALLOWED_EMAILS = 'klaus@klaushofrichter.net';
    const res = await post();
    expect(userFor(sessionValue(res))).toMatchObject({ email: 'local' });
  });

  it('a Google session for the token user name is still checked against the allowlist', () => {
    expect(userFor(signSession('local'))).toBeNull();
  });

  it('a token session for another name is refused', () => {
    const forged = signSession('klaus@klaushofrichter.net');
    expect(userFor(forged)).not.toBeNull(); // allowlisted Google session
    const res = jwt.sign({ email: 'someone-else', via: 'token', tf: '0000000000000000' }, process.env.COOKIE_SECRET!, { algorithm: 'HS256', expiresIn: '7d' });
    expect(userFor(res)).toBeNull();
  });

  it('honours CAMS_TOKEN_USER', async () => {
    tokenOnly();
    process.env.CAMS_TOKEN_USER = 'demo';
    const res = await post();
    expect(jwt.decode(sessionValue(res))).toMatchObject({ email: 'demo' });
    expect(userFor(sessionValue(res))).toMatchObject({ email: 'demo' });
    process.env.CAMS_TOKEN_USER = 'other';
    expect(userFor(sessionValue(res))).toBeNull();
  });

  it('ends when the token changes or token login is turned off', async () => {
    const res = await post();
    const value = sessionValue(res);
    expect(userFor(value)).not.toBeNull();
    process.env.CAMS_LOGIN_TOKEN = 'another-token-entirely-0123456789';
    expect(userFor(value)).toBeNull();
    delete process.env.CAMS_LOGIN_TOKEN;
    expect(userFor(value)).toBeNull();
  });
});

describe('Google routes with a token session or without Google', () => {
  it('skips the silent Google renewal for an expired token session', async () => {
    const res = await post();
    const payload = jwt.decode(sessionValue(res)) as Record<string, unknown>;
    const expired = jwt.sign({ email: payload.email, via: 'token', tf: payload.tf, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.COOKIE_SECRET!, { algorithm: 'HS256' });
    const silent = await request(createApp())
      .get('/auth/google/login?silent=1&returnTo=/app/live')
      .set('Cookie', [`${SESSION_COOKIE}=${expired}`, 'login_hint=klaus%40klaushofrichter.net']);
    expect(silent.status).toBe(302);
    expect(silent.headers.location).toBe('/');
    expect(cookies(silent).join(';')).toMatch(/return_to=%2Fapp%2Flive/);
  });

  it('still renews an expired Google session silently', async () => {
    const expired = jwt.sign({ email: 'klaus@klaushofrichter.net', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.COOKIE_SECRET!, { algorithm: 'HS256' });
    const silent = await request(createApp())
      .get('/auth/google/login?silent=1')
      .set('Cookie', [`${SESSION_COOKIE}=${expired}`, 'login_hint=klaus%40klaushofrichter.net']);
    expect(silent.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it('without Google, /auth/google/login and the callback go to the start page', async () => {
    tokenOnly();
    for (const path of ['/auth/google/login', '/auth/google/login?silent=1', '/auth/google/callback?code=x&state=y']) {
      const res = await request(createApp()).get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.location, path).toBe('/');
    }
  });
});

describe('the start page variants', () => {
  const meta = (html: string) => /<meta name="cams-login" content="([^"]*)"/.exec(html)?.[1];

  it('Google only', async () => {
    delete process.env.CAMS_LOGIN_TOKEN;
    expect(meta((await request(createApp()).get('/')).text)).toBe('google');
  });

  it('both', async () => {
    expect(meta((await request(createApp()).get('/')).text)).toBe('google token');
  });

  it('token only', async () => {
    tokenOnly();
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(meta(res.text)).toBe('token');
    // Never the token itself.
    expect(res.text).not.toContain(TOKEN);
  });
});
