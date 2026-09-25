import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { signSession, verifySession, SESSION_COOKIE } from '../server/session';
import { currentUser, noStore, requireAuthApi, requireAuthPage } from '../server/middleware/requireAuth';

function appWithGuards() {
  const app = express();
  app.use(cookieParser());
  app.get('/whoami', (req, res) => res.json(currentUser(req)));
  app.get('/app/page', noStore, requireAuthPage, (_req, res) => res.send('page'));
  app.get('/api/thing', noStore, requireAuthApi, (_req, res) => res.json({ ok: true }));
  return app;
}
const cookieFor = (email: string) => `${SESSION_COOKIE}=${signSession(email)}`;

describe('session tokens', () => {
  it('round-trips an email', () => {
    expect(verifySession(signSession('klaus@klaushofrichter.net'))).toEqual({ email: 'klaus@klaushofrichter.net' });
  });
  it('rejects a token signed with another secret', () => {
    expect(verifySession(jwt.sign({ email: 'klaus@klaushofrichter.net' }, 'other-secret'))).toBeNull();
  });
  it('rejects an expired token', () => {
    const expired = jwt.sign({ email: 'klaus@klaushofrichter.net' }, process.env.COOKIE_SECRET!, { expiresIn: -10 });
    expect(verifySession(expired)).toBeNull();
  });
  it('rejects a token without an email', () => {
    expect(verifySession(jwt.sign({ sub: 'x' }, process.env.COOKIE_SECRET!))).toBeNull();
  });
});

describe('auth guards', () => {
  afterEach(() => {
    process.env.ALLOWED_EMAILS = 'klaus@klaushofrichter.net';
  });

  it('lets an allowed session through, with no-store', async () => {
    const res = await request(appWithGuards()).get('/api/thing').set('Cookie', cookieFor('klaus@klaushofrichter.net'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers signed-out API calls with 401 JSON and pages with a redirect to /', async () => {
    const app = appWithGuards();
    const api = await request(app).get('/api/thing');
    expect(api.status).toBe(401);
    expect(api.body).toEqual({ error: 'unauthorized' });
    const page = await request(app).get('/app/page');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/');
  });

  // Review focus 1: removing an address must lock out existing sessions at once.
  it('locks out a valid session whose email was removed from ALLOWED_EMAILS', async () => {
    const cookie = cookieFor('klaus@klaushofrichter.net');
    process.env.ALLOWED_EMAILS = 'someone-else@example.com';
    const app = appWithGuards();
    expect((await request(app).get('/api/thing').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).get('/app/page').set('Cookie', cookie)).status).toBe(302);
    expect((await request(app).get('/whoami').set('Cookie', cookie)).body).toBeNull();
  });

  it('trims whitespace and ignores empty entries in ALLOWED_EMAILS', async () => {
    process.env.ALLOWED_EMAILS = ' , klaus@klaushofrichter.net ,';
    const res = await request(appWithGuards()).get('/api/thing').set('Cookie', cookieFor('klaus@klaushofrichter.net'));
    expect(res.status).toBe(200);
  });
});
