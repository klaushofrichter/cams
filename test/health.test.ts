import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';

describe('GET /health', () => {
  afterEach(() => {
    delete process.env.APP_VERSION;
  });

  it('reports ok and "dev" when no version is stamped', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: 'dev' });
  });

  it('reports the stamped APP_VERSION', async () => {
    process.env.APP_VERSION = '2026.09.26.1';
    const res = await request(createApp()).get('/health');
    expect(res.body.version).toBe('2026.09.26.1');
  });
});
