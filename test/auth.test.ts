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
import { signSession } from '../server/session';

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
    expect((res.get('Set-Cookie') ?? []).join(';')).toMatch(/oauth_state=[0-9a-f]{32}/);
  });
});

describe('GET /auth/google/callback', () => {
  it('signs in an allowed, verified account and redirects to /', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookies = (res.get('Set-Cookie') ?? []).join(';');
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
    expect((res.get('Set-Cookie') ?? []).join(';')).toMatch(/return_to=;/);
  });

  it('ignores an unsafe remembered path', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', `${stateCookie}; return_to=${encodeURIComponent('//evil.example/app')}`);
    expect(res.headers.location).toBe('/');
  });
});

describe('cancelled Google sign-in', () => {
  // Review focus 3 (Plan 5): Google redirects back with ?error=access_denied
  // when the user cancels; that must land on the start page, not raw JSON.
  it('also handles a repeated error parameter', async () => {
    const res = await request(createApp()).get('/auth/google/callback?error=a&error=b').set('Cookie', stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it.each(['access_denied', 'interaction_required'])('redirects ?error=%s to / and clears the state cookie', async (error) => {
    const res = await request(createApp())
      .get(`/auth/google/callback?error=${error}&state=${NONCE}.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect((res.get('Set-Cookie') ?? []).join(';')).toMatch(/oauth_state=;/);
  });
});

describe('safeReturnPath', () => {
  it.each([
    ['/app/live', '/app/live'],
    ['/app/recordings?cam=cam1&panel=events', '/app/recordings?cam=cam1&panel=events'],
    ['/app', '/app'],
  ])('accepts %s', (input, expected) => expect(safeReturnPath(input)).toBe(expected));

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/app', '/application', '/apps', '/app//evil', '', undefined, 42,
    '/app/../x', '/app/./live', '/app/..', '/app/%2e%2e/x', '/app/%2E%2e/x', '/app/.%2e/x', '/app/live/../../x',
    'javascript:alert(1)', '/app/\t/evil.example', '/app\n', '/app/\r\nSet-Cookie: x=1', ' /app', 'app/live', ['/app'], '/app/' + 'x'.repeat(3000)])(
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
    const cookies = (res.get('Set-Cookie') ?? []).join(';');
    expect(cookies).toMatch(/session=;.*Expires=Thu, 01 Jan 1970/);
    expect(cookies).toMatch(/oauth_state=;/);
    expect(cookies).toMatch(/return_to=;/);
    // No silent renewal after Logout: the hint is gone too.
    expect(cookies).toMatch(/login_hint=;/);
    // Clear-Site-Data applies to the whole registrable domain, which would
    // sign the user out of every *.skylar.technology service. Not used.
    expect(res.headers['clear-site-data']).toBeUndefined();
  });

  // CodeQL js/missing-rate-limiting (PR #155): Logout touches the sign-in
  // cookies, so it shares the sign-in routes' limiter.
  it('is rate-limited like the sign-in routes', async () => {
    const res = await request(createApp()).get('/auth/logout');
    expect(res.headers['ratelimit-policy'] ?? res.headers['ratelimit']).toBeDefined();
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

// Issue #153, R2: an expired session renewed without the user (prompt=none),
// back to the same page; else the start page, whose sign-in comes back too.
describe('silent renewal and returnTo', () => {
  const HINT = 'login_hint=klaus%40klaushofrichter.net';
  const cookiesOf = (res: request.Response) => (res.get('Set-Cookie') ?? []).join(';');

  it('remembers a safe returnTo on the normal sign-in', async () => {
    const res = await request(createApp()).get(`/auth/google/login?returnTo=${encodeURIComponent('/app/settings?cam=cam1')}`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).searchParams.get('prompt')).toBe('select_account');
    expect(cookiesOf(res)).toContain(`return_to=${encodeURIComponent('/app/settings?cam=cam1')}`);
  });

  it.each(['//evil.example', 'https://evil.example/app', '/\\evil.example', '/app/../x', 'javascript:alert(1)', '/app/%2e%2e/admin'])(
    'ignores the open-redirect attempt returnTo=%s',
    async (bad) => {
      const res = await request(createApp()).get(`/auth/google/login?silent=1&returnTo=${encodeURIComponent(bad)}`).set('Cookie', HINT);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
      expect(cookiesOf(res)).not.toContain('return_to=');
    },
  );

  it('ignores a repeated returnTo (not a string)', async () => {
    const res = await request(createApp()).get('/auth/google/login?returnTo=/app/live&returnTo=/app/about');
    expect(cookiesOf(res)).not.toContain('return_to=');
  });

  it('silent=1 asks Google with prompt=none for the account of the last sign-in', async () => {
    const res = await request(createApp()).get('/auth/google/login?silent=1&returnTo=%2Fapp%2Fabout').set('Cookie', HINT);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.searchParams.get('prompt')).toBe('none');
    expect(url.searchParams.get('login_hint')).toBe('klaus@klaushofrichter.net');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}\.silent$/);
    expect(cookiesOf(res)).toMatch(/oauth_state=[0-9a-f]{32}/);
    expect(cookiesOf(res)).toContain('return_to=%2Fapp%2Fabout');
  });

  it('silent=1 without a hint (never signed in here, or logged out) goes to the start page, keeping returnTo', async () => {
    const res = await request(createApp()).get('/auth/google/login?silent=1&returnTo=%2Fapp%2Fabout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(cookiesOf(res)).toContain('return_to=%2Fapp%2Fabout');
  });

  it('ignores a malformed hint', async () => {
    const res = await request(createApp()).get('/auth/google/login?silent=1').set('Cookie', 'login_hint=not-an-email');
    expect(res.headers.location).toBe('/');
  });

  it('a successful sign-in remembers the account as the hint (httpOnly, 30 days)', async () => {
    const res = await request(createApp()).get(`/auth/google/callback?code=c&state=${NONCE}.first`).set('Cookie', stateCookie);
    expect(cookiesOf(res)).toMatch(/login_hint=klaus%40klaushofrichter\.net; Max-Age=2592000;[^;]*;[^;]*; HttpOnly; Secure; SameSite=Lax/);
  });

  it('a successful silent renewal signs in and returns to the remembered page', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.silent`)
      .set('Cookie', `${stateCookie}; ${HINT}; return_to=%2Fapp%2Fabout`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/about');
    expect(cookiesOf(res)).toMatch(/session=[^;]+; Max-Age=604800/);
  });

  it.each(['login_required', 'interaction_required', 'consent_required', 'account_selection_required'])(
    'a silent renewal Google answers with %s lands on the start page, still remembering the page',
    async (error) => {
      const res = await request(createApp())
        .get(`/auth/google/callback?error=${error}&state=${NONCE}.silent`)
        .set('Cookie', `${stateCookie}; ${HINT}; return_to=%2Fapp%2Fabout`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
      expect(cookiesOf(res)).not.toMatch(/session=/);
      expect(cookiesOf(res)).not.toMatch(/return_to=;/);
    },
  );

  it('a silent renewal is as strict about state as a normal sign-in', async () => {
    const res = await request(createApp())
      .get('/auth/google/callback?code=c&state=ffffffffffffffffffffffffffffffff.silent')
      .set('Cookie', `${stateCookie}; ${HINT}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid state' });
    const unknown = await request(createApp()).get(`/auth/google/callback?code=c&state=${NONCE}.other`).set('Cookie', stateCookie);
    expect(unknown.status).toBe(401);
  });

  it('a silent renewal for an account no longer allowed signs nobody in and forgets the hint', async () => {
    google.payload = { email: 'intruder@example.com', email_verified: true };
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.silent`)
      .set('Cookie', `${stateCookie}; login_hint=intruder%40example.com`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(cookiesOf(res)).not.toMatch(/session=/);
    expect(cookiesOf(res)).toMatch(/login_hint=;/);
  });

  it('the start page remembers a safe returnTo, and ignores an unsafe one', async () => {
    const good = await request(createApp()).get('/?returnTo=%2Fapp%2Ftimeline');
    expect(good.status).toBe(200);
    expect(cookiesOf(good)).toContain('return_to=%2Fapp%2Ftimeline');
    const bad = await request(createApp()).get(`/?returnTo=${encodeURIComponent('//evil.example')}`);
    expect(bad.status).toBe(200);
    expect(cookiesOf(bad)).not.toContain('return_to=');
  });

  // Security review of #155: a third-party page must not open a chosen /app
  // page for a signed-in user, so ?returnTo= counts only when signed out.
  it('the start page ignores ?returnTo= for a visitor already signed in', async () => {
    const session = `session=${signSession('klaus@klaushofrichter.net')}`;
    const res = await request(createApp()).get('/?returnTo=%2Fapp%2Ftimeline').set('Cookie', session);
    expect(res.headers.location).toBe('/app/live');
    expect(cookiesOf(res)).not.toContain('return_to=%2Fapp');
  });

  it('the start page sends a visitor already signed in (another tab) to the remembered page', async () => {
    const session = `session=${signSession('klaus@klaushofrichter.net')}`;
    const viaCookie = await request(createApp()).get('/').set('Cookie', `${session}; return_to=%2Fapp%2Fabout`);
    expect(viaCookie.headers.location).toBe('/app/about');
    expect(cookiesOf(viaCookie)).toMatch(/return_to=;/);
    const unsafe = await request(createApp()).get(`/?returnTo=${encodeURIComponent('https://evil.example')}`).set('Cookie', session);
    expect(unsafe.headers.location).toBe('/app/live');
  });
});
