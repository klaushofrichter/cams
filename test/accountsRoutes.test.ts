// The account picker (migration P4, M §9.5, R4-13): GET /api/accounts and
// POST /api/session/account, and the Google callback with several accounts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const google = vi.hoisted(() => ({ payload: {} as Record<string, unknown> }));
vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(function () {
    return {
      getToken: vi.fn(async () => ({ tokens: { id_token: 'id-token' } })),
      verifyIdToken: vi.fn(async () => ({ getPayload: () => google.payload })),
    };
  }),
}));

import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { SESSION_COOKIE, verifySession } from '../server/session';
import { ALPHA, BETA, applyFleet, cookieFor, restoreMode, twoAccounts } from './helpers/fleet';

const NONCE = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://127.0.0.1';
const sessionOf = (res: request.Response) => {
  const c = (res.get('Set-Cookie') ?? []).find((x) => x.startsWith(`${SESSION_COOKIE}=`));
  return c ? verifySession(c.split(';')[0].slice(SESSION_COOKIE.length + 1)) : null;
};
const callback = (extraCookie = '') =>
  request(createApp()).get(`/auth/google/callback?code=c&state=${NONCE}.first`).set('Cookie', `oauth_state=${NONCE}${extraCookie}`);

beforeEach(() => applyFleet(twoAccounts()));
afterEach(() => {
  restoreMode();
  setCameras([]);
});

describe('the picker', () => {
  it('GET /api/accounts lists memberships with roles and the remembered one; POST switches and re-signs; a non-member account → 404', async () => {
    const c = cookieFor('both@example.org');
    const list = await request(createApp()).get('/api/accounts').set('Cookie', `${c}; cams_account=${BETA}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      { id: ALPHA, name: 'alpha', displayName: 'Alpha', role: 'admin', current: false, remembered: false },
      { id: BETA, name: 'beta', displayName: 'Beta', role: 'viewer', current: false, remembered: true },
    ]);
    const post = await request(createApp()).post('/api/session/account').set('Cookie', c).set('Origin', ORIGIN).set('Host', '127.0.0.1').send({ accountId: BETA });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ redirect: '/app/video' });
    expect(sessionOf(post)).toMatchObject({ email: 'both@example.org', acc: BETA });
    const remember = (post.get('Set-Cookie') ?? []).find((x) => x.startsWith('cams_account='))!;
    expect(remember).toMatch(new RegExp(`^cams_account=${BETA};`));
    expect(remember).toMatch(/HttpOnly/);
    const current = await request(createApp()).get('/api/accounts').set('Cookie', cookieFor('both@example.org', BETA));
    expect(current.body.items.map((i: { current: boolean }) => i.current)).toEqual([false, true]);
    const not = await request(createApp()).post('/api/session/account').set('Cookie', cookieFor('alpha@example.org', ALPHA)).set('Origin', ORIGIN).set('Host', '127.0.0.1').send({ accountId: BETA });
    expect([not.status, not.body.error]).toEqual([404, 'not_a_member']);
    const bad = await request(createApp()).post('/api/session/account').set('Cookie', c).set('Origin', ORIGIN).set('Host', '127.0.0.1').send({ accountId: 42 });
    expect(bad.status).toBe(404);
  });

  it('cross-site POST /api/session/account is refused (requireSameOrigin)', async () => {
    const r = await request(createApp()).post('/api/session/account').set('Cookie', cookieFor('both@example.org')).set('Origin', 'https://evil.example').set('Host', '127.0.0.1').send({ accountId: BETA });
    expect(r.status).toBe(403);
    expect(sessionOf(r)).toBeNull();
  });

  it('signed out → 401', async () => {
    expect((await request(createApp()).get('/api/accounts')).status).toBe(401);
  });
});

describe('the Google callback', () => {
  it('two memberships → session without acc, redirect /app/accounts (the return path kept); one → straight in with acc', async () => {
    google.payload = { email: 'both@example.org', email_verified: true };
    const two = await callback('; return_to=/app/recordings');
    expect(two.status).toBe(302);
    expect(two.headers.location).toBe('/app/accounts');
    expect(sessionOf(two)).toEqual({ email: 'both@example.org' });
    expect((two.get('Set-Cookie') ?? []).some((x) => x.startsWith('return_to=;'))).toBe(false);
    google.payload = { email: 'alpha@example.org', email_verified: true };
    const one = await callback();
    expect(one.headers.location).toBe('/');
    expect(sessionOf(one)).toEqual({ email: 'alpha@example.org', acc: ALPHA });
  });

  it('no membership → not allowed (the existing re-select flow)', async () => {
    google.payload = { email: 'nobody@example.org', email_verified: true };
    const r = await callback();
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it('the start page sends a person who must choose to the picker', async () => {
    const r = await request(createApp()).get('/').set('Cookie', cookieFor('both@example.org'));
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/app/accounts');
  });
});
