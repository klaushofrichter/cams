// Memberships and roles (migration P4, M §9.5, R4-13, R4-14): the role comes
// from the applied configuration on every request, never from the cookie.
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Request } from 'express';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { fileAccount } from '../server/fleet';
import { membershipsOf, tokenAccount } from '../server/membership';
import { authState, currentUser } from '../server/middleware/requireAuth';
import { configMode } from '../server/configSource';
import { SESSION_COOKIE, signSession, verifySession } from '../server/session';
import { ALPHA, BETA, applyFleet, cookieFor, restoreMode, twoAccounts } from './helpers/fleet';

const reqWith = (cookie: string) => ({ cookies: { [SESSION_COOKIE]: cookie.slice(SESSION_COOKIE.length + 1) } }) as unknown as Request;
const get = (path: string, cookie: string) => request(createApp()).get(path).set('Cookie', cookie);

afterEach(() => {
  restoreMode();
  delete process.env.CAMS_TOKEN_ACCOUNT;
  setCameras([]);
});

describe('configMode', () => {
  it('defaults to file; names CONFIG_SOURCE when wrong', () => {
    expect(configMode()).toBe(process.env.CONFIG_SOURCE ?? 'file');
    const saved = process.env.CONFIG_SOURCE;
    process.env.CONFIG_SOURCE = 'bogus';
    try {
      expect(() => configMode()).toThrow(/CONFIG_SOURCE/);
    } finally {
      if (saved === undefined) delete process.env.CONFIG_SOURCE;
      else process.env.CONFIG_SOURCE = saved;
    }
  });
});

describe('sessions carry the account', () => {
  it('signSession(email, acc) round-trips acc; a bad acc is dropped', () => {
    expect(verifySession(signSession('a@example.org', ALPHA))).toEqual({ email: 'a@example.org', acc: ALPHA });
    expect(verifySession(signSession('a@example.org'))).toEqual({ email: 'a@example.org' });
  });
});

describe('memberships', () => {
  it('file mode: ALLOWED_EMAILS members are admin of the file account; the cookie needs no acc (old cookies keep working)', async () => {
    setCameras([]);
    expect(membershipsOf('klaus@klaushofrichter.net')).toEqual([{ account: fileAccount(), role: 'admin' }]);
    expect(membershipsOf('stranger@example.org')).toEqual([]);
    const old = cookieFor('klaus@klaushofrichter.net');
    expect(currentUser(reqWith(old))).toMatchObject({ email: 'klaus@klaushofrichter.net', via: 'google', role: 'admin', account: fileAccount() });
    // a cookie with an acc from cams-admin mode: ignored in file mode
    expect(currentUser(reqWith(cookieFor('klaus@klaushofrichter.net', BETA)))).toMatchObject({ account: fileAccount(), role: 'admin' });
    const me = await get('/api/me', old);
    expect(me.body).toMatchObject({ email: 'klaus@klaushofrichter.net', role: 'admin', account: { id: fileAccount().id, name: 'home' }, accounts: 1, configSource: 'file' });
  });

  it('cams-admin mode: the role comes from the applied snapshot on every request, never from the cookie', async () => {
    applyFleet(twoAccounts());
    const c = cookieFor('both@example.org', BETA);
    expect((await get('/api/me', c)).body).toMatchObject({ role: 'viewer', account: { name: 'beta' }, accounts: 2, configSource: 'cams-admin' });
    applyFleet(twoAccounts({ betaRole: 'admin' }));
    expect((await get('/api/me', c)).body.role).toBe('admin');
    applyFleet(twoAccounts({ betaRemoved: 'both@example.org' }));
    expect((await get('/api/me', c)).status).toBe(401);
  });

  it('a disabled user is not a member; email compare is case-insensitive', () => {
    const accounts = twoAccounts();
    accounts[1].users = [{ email: 'both@example.org', role: 'viewer', disabled: true }];
    applyFleet(accounts);
    expect(membershipsOf('Both@Example.ORG').map((m) => [m.account.id, m.role])).toEqual([[ALPHA, 'admin']]);
    expect(membershipsOf('alpha@example.org')).toHaveLength(1);
    expect(membershipsOf('nobody@example.org')).toEqual([]);
  });

  it('memberships are sorted by account name', () => {
    const [a, b] = twoAccounts();
    applyFleet([b, a]);
    expect(membershipsOf('both@example.org').map((m) => m.account.name)).toEqual(['alpha', 'beta']);
  });

  it('a cookie whose acc is not (or no longer) a membership → 401; a cookie without acc and one membership → that account; several → 409 choose_account', async () => {
    applyFleet(twoAccounts());
    expect((await get('/api/me', cookieFor('alpha@example.org', BETA))).status).toBe(401);
    expect((await get('/api/me', cookieFor('alpha@example.org'))).body).toMatchObject({ account: { id: ALPHA }, role: 'admin' });
    const several = cookieFor('both@example.org');
    expect(authState(reqWith(several))).toMatchObject({ kind: 'choose', email: 'both@example.org' });
    const cams = await get('/api/cameras', several);
    expect([cams.status, cams.body.error]).toEqual([409, 'choose_account']);
    // the picker routes and /api/me still answer
    expect((await get('/api/me', several)).body).toMatchObject({ email: 'both@example.org', account: null, role: null, accounts: 2 });
    expect((await get('/api/accounts', several)).status).toBe(200);
    expect((await get('/api/me', cookieFor('nobody@example.org'))).status).toBe(401);
  });
});

describe('the token account (R4-14)', () => {
  it('file mode: the file account', () => {
    expect(tokenAccount()).toEqual({ ok: true, account: fileAccount() });
  });
  it('CAMS_TOKEN_ACCOUNT names the account; unset with one served account → that one; unset with two → ambiguous; an unknown name → unknown; none served → none', () => {
    applyFleet(twoAccounts());
    expect(tokenAccount()).toEqual({ ok: false, reason: 'ambiguous' });
    process.env.CAMS_TOKEN_ACCOUNT = 'beta';
    expect(tokenAccount()).toMatchObject({ ok: true, account: { id: BETA } });
    process.env.CAMS_TOKEN_ACCOUNT = 'gamma';
    expect(tokenAccount()).toEqual({ ok: false, reason: 'unknown' });
    delete process.env.CAMS_TOKEN_ACCOUNT;
    applyFleet([twoAccounts()[0]]);
    expect(tokenAccount()).toMatchObject({ ok: true, account: { id: ALPHA } });
    applyFleet([]);
    expect(tokenAccount()).toEqual({ ok: false, reason: 'none' });
  });
});

describe('token sign-in with accounts (R4-14)', () => {
  const TOKEN = 'demo-kit-token-0123456789abcdef';
  const post = () => request(createApp()).post('/auth/token').set('Origin', 'http://127.0.0.1').set('Host', '127.0.0.1').send({ token: TOKEN });
  const sessionCookie = (r: request.Response) => (r.get('Set-Cookie') ?? []).find((x) => x.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
  afterEach(() => delete process.env.CAMS_LOGIN_TOKEN);
  it('unset with two served accounts → 503 token_account_ambiguous; CAMS_TOKEN_ACCOUNT names one → admin there', async () => {
    process.env.CAMS_LOGIN_TOKEN = TOKEN;
    applyFleet(twoAccounts());
    const r = await post();
    expect([r.status, r.body.error]).toEqual([503, 'token_account_ambiguous']);
    expect(sessionCookie(r)).toBeUndefined();
    process.env.CAMS_TOKEN_ACCOUNT = 'beta';
    const ok = await post();
    expect(ok.status).toBe(200);
    const me = await get('/api/me', sessionCookie(ok)!);
    expect(me.body).toMatchObject({ role: 'admin', account: { id: BETA }, accounts: 1 });
    const pick = await request(createApp()).post('/api/session/account').set('Cookie', sessionCookie(ok)!).send({ accountId: ALPHA });
    expect([pick.status, pick.body.error]).toEqual([409, 'token_session']);
  });
});
