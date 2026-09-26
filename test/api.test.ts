import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../server/app';
import { SESSION_COOKIE, signSession } from '../server/session';
import { setCameras } from '../server/cameraRegistry';
import { requireSameOrigin } from '../server/middleware/requireSameOrigin';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;

afterEach(() => {
  setCameras([]);
  delete process.env.APP_VERSION;
});

describe('/api', () => {
  it('GET /api/me returns the email and version, uncached', async () => {
    process.env.APP_VERSION = '2026.09.26.1';
    const res = await request(createApp()).get('/api/me').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'klaus@klaushofrichter.net', version: '2026.09.26.1' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/cameras lists configured cameras without credentials', async () => {
    setCameras([{ id: 'cam1', name: 'Den', host: '10.0.0.5', protocol: 'https', user: 'cams', password: 'pw' }]);
    const res = await request(createApp()).get('/api/cameras').set('Cookie', auth);
    expect(res.body).toEqual([{ id: 'cam1', name: 'Den', webUiUrl: 'https://10.0.0.5/' }]);
    expect(JSON.stringify(res.body)).not.toContain('pw');
  });

  it('requires a session', async () => {
    expect((await request(createApp()).get('/api/me')).status).toBe(401);
    expect((await request(createApp()).get('/api/cameras')).status).toBe(401);
  });

  // Review focus 5: unknown API paths answer JSON, never the SPA.
  it('answers unknown /api paths with JSON 404 even when signed in', async () => {
    const res = await request(createApp()).get('/api/nope').set('Cookie', auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});

describe('requireSameOrigin', () => {
  const app = express();
  app.use(requireSameOrigin);
  app.post('/x', (_req, res) => res.json({ ok: true }));
  app.get('/x', (_req, res) => res.json({ ok: true }));

  it('lets safe methods through regardless of origin', async () => {
    expect((await request(app).get('/x').set('Origin', 'https://evil.example')).status).toBe(200);
  });
  it('rejects a cross-origin POST', async () => {
    const res = await request(app).post('/x').set('Host', 'cams.skylar.technology').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
  it('accepts a same-origin POST', async () => {
    const res = await request(app).post('/x').set('Host', '127.0.0.1').set('Origin', 'http://127.0.0.1');
    expect(res.status).toBe(200);
  });
  it('accepts a POST without Origin or Referer (non-browser client)', async () => {
    expect((await request(app).post('/x')).status).toBe(200);
  });
});
