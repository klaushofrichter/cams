import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const google = vi.hoisted(() => ({ payload: {} as Record<string, unknown>, fail: false }));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(function () {
    return {
      getToken: vi.fn(async () => {
        if (google.fail) throw new Error('bad code');
        return { tokens: { id_token: 'id-token' } };
      }),
      verifyIdToken: vi.fn(async () => ({ getPayload: () => google.payload })),
    };
  }),
}));

import { createApp } from '../server/app';
import { safeReturnPath } from '../server/routes/auth';
import { requireAuthApi } from '../server/middleware/requireAuth';

const NONCE = '0123456789abcdef0123456789abcdef';
const stateCookie = `oauth_state=${NONCE}`;

beforeEach(() => {
  google.payload = { email: 'klaus@klaushofrichter.net', email_verified: true };
  google.fail = false;
});

describe('GET /auth/google/login', () => {
  it('redirects to Google with openid email scope and sets a state cookie', async () => {
    const res = await request(createApp()).get('/auth/google/login');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    // Requirement: after Logout, signing in must not happen silently.
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}\.first$/);
    expect(res.headers['set-cookie'].join(';')).toMatch(/oauth_state=[0-9a-f]{32}/);
  });
});

describe('GET /auth/google/callback', () => {
  it('signs in an allowed, verified account and redirects to /', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/session=[^;]+; Max-Age=604800/);
    expect(cookies).toMatch(/HttpOnly/);
    expect(cookies).toMatch(/Secure/);
    expect(cookies).toMatch(/SameSite=Lax/);
  });

  it('rejects a state that does not match the cookie', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=ffffffffffffffffffffffffffffffff.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid state' });
  });

  it('rejects an empty nonce cookie paired with an empty state', async () => {
    const res = await request(createApp())
      .get('/auth/google/callback?code=c&state=.first')
      .set('Cookie', 'oauth_state=');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid state' });
  });

  it('rejects a missing code', async () => {
    const res = await request(createApp()).get(`/auth/google/callback?state=${NONCE}.first`).set('Cookie', stateCookie);
    expect(res.status).toBe(401);
  });

  it('rejects an unverified email', async () => {
    google.payload = { email: 'klaus@klaushofrichter.net', email_verified: false };
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(401);
  });

  it('answers a failed code exchange with 401', async () => {
    google.fail = true;
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(401);
  });

  it('retries once with the account chooser for a disallowed account, then 403', async () => {
    google.payload = { email: 'intruder@example.com', email_verified: true };
    const app = createApp();
    const first = await request(app).get(`/auth/google/callback?code=c&state=${NONCE}.first`).set('Cookie', stateCookie);
    expect(first.status).toBe(302);
    expect(new URL(first.headers.location).searchParams.get('prompt')).toBe('select_account');
    const second = await request(app).get(`/auth/google/callback?code=c&state=${NONCE}.reselect`).set('Cookie', stateCookie);
    expect(second.status).toBe(403);
  });

  // Review focus 2: a signed-out deep link comes back after sign-in.
  it('redirects to a remembered /app path after sign-in and clears it', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', `${stateCookie}; return_to=${encodeURIComponent('/app/settings?cam=cam1')}`);
    expect(res.headers.location).toBe('/app/settings?cam=cam1');
    expect(res.headers['set-cookie'].join(';')).toMatch(/return_to=;/);
  });

  it('ignores an unsafe remembered path', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', `${stateCookie}; return_to=${encodeURIComponent('//evil.example/app')}`);
    expect(res.headers.location).toBe('/');
  });
});

describe('safeReturnPath', () => {
  it.each([
    ['/app/live', '/app/live'],
    ['/app/recordings?cam=cam1&panel=events', '/app/recordings?cam=cam1&panel=events'],
    ['/app', '/app'],
  ])('accepts %s', (input, expected) => expect(safeReturnPath(input)).toBe(expected));

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/app', '/application', '/apps', '/app//evil', '', undefined, 42])(
    'rejects %s',
    (input) => expect(safeReturnPath(input)).toBeNull()
  );
});

describe('GET /auth/logout', () => {
  it('removes every app cookie and returns to /, without a domain-wide Clear-Site-Data header', async () => {
    const res = await request(createApp())
      .get('/auth/logout')
      .set('Cookie', `session=abc; oauth_state=${NONCE}; return_to=%2Fapp%2Flive`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/session=;.*Expires=Thu, 01 Jan 1970/);
    expect(cookies).toMatch(/oauth_state=;/);
    expect(cookies).toMatch(/return_to=;/);
    // Clear-Site-Data applies to the whole registrable domain, which would
    // sign the user out of every *.skylar.technology service. Not used.
    expect(res.headers['clear-site-data']).toBeUndefined();
  });

  it('leaves the old session unusable once the browser drops the cookie', async () => {
    // /api/me itself is a Task 5 deliverable and does not exist on this
    // router yet; a route guarded by the real requireAuthApi middleware
    // exercises the same "session cleared -> unauthorized" behavior.
    const app = createApp();
    app.get('/api/me', requireAuthApi, (_req, res) => res.json({ ok: true }));
    await request(app).get('/auth/logout');
    expect((await request(app).get('/api/me')).status).toBe(401);
  });
});
