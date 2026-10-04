// The plain save's limit (Klaus, 2026-10-04): a recording as it is, SD or
// 4K, up to 600 s. The Save dialog mirrors it (server/clipLimits.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { clipSeconds } from '../server/recordings/clipNames';
import { SESSION_COOKIE, signSession } from '../server/session';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
beforeEach(() => setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]));
afterEach(() => setCameras([]));
const get = (id: string, q = 'sub') => request(createApp()).get(`/api/cameras/den/clips/${id}/download?quality=${q}`).set('Cookie', auth);

describe('the plain save limit', () => {
  it('reads a recording\'s length from its id, across midnight too', () => {
    expect(clipSeconds('20261004-071650-071844')).toBe(114);
    expect(clipSeconds('20261004-235500-000600')).toBe(660);
  });

  it('refuses a recording longer than 600 s, in either quality, without asking the camera', async () => {
    for (const q of ['sub', 'main']) {
      const r = await get('20261004-070000-071001', q);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'too_long', detail: 'At most 600 s (10:00)' });
    }
    expect((await get('20261004-235500-000600')).body).toMatchObject({ error: 'too_long' });
  });

  it('lets one of 600 s through to the camera', async () => {
    const r = await get('20261004-070000-071000');
    expect(r.body.error).not.toBe('too_long');
  });
});
