import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// I1: clip media (video/thumb/download) has its own, much higher budget,
// and the general API limiter skips those routes entirely. The module-level
// caps are read once at import time from env, so each case here resets the
// module registry and re-imports with its own env to get an isolated,
// low-enough max to actually hit.
async function freshLimiters(env: Record<string, string>) {
  vi.resetModules();
  Object.assign(process.env, env);
  return import('../server/middleware/rateLimit.js');
}

function buildApp(createApiRateLimit: () => express.RequestHandler, createMediaRateLimit: () => express.RequestHandler, createImageRateLimit?: () => express.RequestHandler) {
  const app = express();
  app.use(createApiRateLimit(), createMediaRateLimit());
  if (createImageRateLimit) app.use(createImageRateLimit());
  app.get('/me', (_req, res) => res.json({ ok: true }));
  app.get('/cameras/:id/clips/:clipId/thumb.jpg', (_req, res) => res.json({ ok: true }));
  app.get('/cameras/:id/previews/:file', (_req, res) => res.json({ ok: true }));
  app.get('/cameras/:id/stills/:file', (_req, res) => res.json({ ok: true }));
  app.get('/cameras/:id/still/latest.jpg', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rate limits', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_API_MAX;
    delete process.env.RATE_LIMIT_MEDIA_MAX;
    delete process.env.RATE_LIMIT_IMAGE_MAX;
    delete process.env.RATE_LIMIT_PTZ_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    vi.resetModules();
  });

  it('many media requests do not consume the general API budget', async () => {
    const { createApiRateLimit, createMediaRateLimit } = await freshLimiters({
      RATE_LIMIT_API_MAX: '2',
      RATE_LIMIT_MEDIA_MAX: '50',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    const app = buildApp(createApiRateLimit, createMediaRateLimit);
    for (let i = 0; i < 10; i++) {
      expect((await request(app).get('/cameras/cam1/clips/x/thumb.jpg')).status).toBe(200);
    }
    // The general budget (2) would already be exhausted if media requests
    // had counted against it.
    expect((await request(app).get('/me')).status).toBe(200);
  });

  // Plan 6: a day on the Timeline is up to 1440 sprites, plus stills. Since
  // 2026-09-29 they have their own budget: a burst of stills (a drag through
  // History) spent the shared one, and the Timeline's sprites got 429.
  it('gives proxy sprites and stills their own budget, apart from the API and clip media', async () => {
    const { createApiRateLimit, createMediaRateLimit, createImageRateLimit } = await freshLimiters({
      RATE_LIMIT_API_MAX: '2',
      RATE_LIMIT_MEDIA_MAX: '3',
      RATE_LIMIT_IMAGE_MAX: '50',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    const app = buildApp(createApiRateLimit, createMediaRateLimit, createImageRateLimit);
    for (let i = 0; i < 10; i++) {
      expect((await request(app).get(`/cameras/cam1/previews/${i}.jpg`)).status).toBe(200);
      expect((await request(app).get(`/cameras/cam1/stills/${i}.jpg`)).status).toBe(200);
      expect((await request(app).get('/cameras/cam1/still/latest.jpg')).status).toBe(200); // the Live fallback, once a second
    }
    expect((await request(app).get('/me')).status).toBe(200); // the API budget (2) untouched
    expect((await request(app).get('/cameras/cam1/clips/x/thumb.jpg')).status).toBe(200); // clip media (3) untouched
  });

  it('answers 429 for stills once their own budget is spent, without touching clip media', async () => {
    const { createApiRateLimit, createMediaRateLimit, createImageRateLimit } = await freshLimiters({
      RATE_LIMIT_API_MAX: '1000',
      RATE_LIMIT_MEDIA_MAX: '1000',
      RATE_LIMIT_IMAGE_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    const app = buildApp(createApiRateLimit, createMediaRateLimit, createImageRateLimit);
    await request(app).get('/cameras/cam1/stills/1.jpg');
    await request(app).get('/cameras/cam1/previews/2.jpg');
    expect((await request(app).get('/cameras/cam1/stills/3.jpg')).status).toBe(429);
    expect((await request(app).get('/cameras/cam1/clips/x/thumb.jpg')).status).toBe(200);
  });

  it('answers a media request 429 once the media limit itself is exceeded', async () => {
    const { createApiRateLimit, createMediaRateLimit } = await freshLimiters({
      RATE_LIMIT_API_MAX: '1000',
      RATE_LIMIT_MEDIA_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    const app = buildApp(createApiRateLimit, createMediaRateLimit);
    await request(app).get('/cameras/cam1/clips/x/thumb.jpg');
    await request(app).get('/cameras/cam1/clips/x/thumb.jpg');
    expect((await request(app).get('/cameras/cam1/clips/x/thumb.jpg')).status).toBe(429);
  });

  // Holding the PTZ pad sends 4 moves a second (plan 2026-10-30-ptz-panel,
  // Review Focus 1): they get their own budget, so a long hold can't lock the
  // page out of everything else.
  function ptzApp(m: { createApiRateLimit: () => express.RequestHandler; createPtzRateLimit: () => express.RequestHandler }) {
    const app = express();
    app.use(m.createApiRateLimit(), m.createPtzRateLimit());
    app.get('/me', (_req, res) => res.json({ ok: true }));
    for (const op of ['move', 'zoom', 'focus', 'stop']) app.post(`/cameras/:id/ptz/${op}`, (_req, res) => res.status(204).end());
    app.get('/cameras/:id/ptz/positions', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('PTZ control calls pass beyond the API budget and leave it untouched', async () => {
    const m = await freshLimiters({ RATE_LIMIT_API_MAX: '3', RATE_LIMIT_PTZ_MAX: '50', RATE_LIMIT_WINDOW_MS: '60000' });
    const app = ptzApp(m);
    for (let i = 0; i < 10; i++) for (const op of ['move', 'zoom', 'focus', 'stop']) expect((await request(app).post(`/cameras/cam1/ptz/${op}`)).status).toBe(204);
    expect((await request(app).get('/me')).status).toBe(200);
    expect((await request(app).get('/cameras/cam1/ptz/positions')).status).toBe(200); // positions count as API calls
  });

  it('answers a PTZ control call 429 once its own budget is spent, without touching the API budget', async () => {
    const m = await freshLimiters({ RATE_LIMIT_API_MAX: '1000', RATE_LIMIT_PTZ_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' });
    const app = ptzApp(m);
    for (let i = 0; i < 3; i++) expect((await request(app).post('/cameras/cam1/ptz/move')).status).toBe(204);
    expect((await request(app).post('/cameras/cam1/ptz/move')).status).toBe(429);
    expect((await request(app).get('/me')).status).toBe(200);
  });

  it('defaults to 1500 PTZ control calls per window', async () => {
    const m = await freshLimiters({});
    expect(m.PTZ_MAX).toBe(1500);
    expect(m.PTZ_CONTROL_PATH.test('/cameras/den/ptz/move')).toBe(true);
    expect(m.PTZ_CONTROL_PATH.test('/cameras/den/ptz/positions')).toBe(false);
  });
});
