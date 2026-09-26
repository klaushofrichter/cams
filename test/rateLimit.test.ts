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
  return import('../server/middleware/rateLimit');
}

function buildApp(createApiRateLimit: () => express.RequestHandler, createMediaRateLimit: () => express.RequestHandler) {
  const app = express();
  app.use(createApiRateLimit(), createMediaRateLimit());
  app.get('/me', (_req, res) => res.json({ ok: true }));
  app.get('/cameras/:id/clips/:clipId/thumb.jpg', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rate limits', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_API_MAX;
    delete process.env.RATE_LIMIT_MEDIA_MAX;
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
});
