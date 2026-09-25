import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { SESSION_COOKIE, signSession } from '../server/session';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;

beforeAll(() => {
  process.env.WEB_DIST = resolve(__dirname, 'fixtures/web');
});
afterAll(() => {
  delete process.env.WEB_DIST;
});

describe('pages', () => {
  it('serves the landing page to signed-out visitors', async () => {
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('LANDING');
  });

  it('sends signed-in visitors from / to /app/live', async () => {
    const res = await request(createApp()).get('/').set('Cookie', auth);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/live');
  });

  it('serves the app shell for any /app path when signed in, uncached', async () => {
    for (const path of ['/app', '/app/live', '/app/recordings?panel=events', '/app/unknown/deep']) {
      const res = await request(createApp()).get(path).set('Cookie', auth);
      expect(res.status, path).toBe(200);
      expect(res.text).toContain('APP');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('redirects signed-out /app requests to / and remembers the path', async () => {
    const res = await request(createApp()).get('/app/settings');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.headers['set-cookie'].join(';')).toContain('return_to=%2Fapp%2Fsettings');
  });

  it('serves static files like the favicon publicly', async () => {
    const res = await request(createApp()).get('/favicon.svg');
    expect(res.status).toBe(200);
  });

  it('does not expose app.html directly', async () => {
    const res = await request(createApp()).get('/app.html');
    expect(res.status).toBe(404);
  });

  // Review: the HTML entries must not be reachable through encoded or
  // differently-cased names, bypassing the auth decision on / and /app.
  it('does not expose index.html or app.html via encoded or cased names', async () => {
    for (const path of ['/index.html', '/app.html', '/%61pp.html', '/APP.html', '/App.HTML', '/%2e/app.html']) {
      const res = await request(createApp()).get(path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain('APP');
    }
  });

  // Review focus 5: unknown paths are 404, not the landing page.
  it('answers unknown paths with 404', async () => {
    const res = await request(createApp()).get('/wp-login.php');
    expect(res.status).toBe(404);
  });
});
