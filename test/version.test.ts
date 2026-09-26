import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { buildDate } from '../server/version';
import { SESSION_COOKIE, signSession } from '../server/session';

afterEach(() => {
  delete process.env.BUILD_DATE;
});

describe('build date', () => {
  it('is null when not stamped, and ISO when stamped', async () => {
    expect(buildDate()).toBeNull();
    process.env.BUILD_DATE = '2026-09-26T12:48:33Z';
    expect(buildDate()).toBe('2026-09-26T12:48:33.000Z');
    process.env.BUILD_DATE = 'garbage';
    expect(buildDate()).toBeNull();
  });

  it('is reported by /api/me', async () => {
    process.env.BUILD_DATE = '2026-09-26T12:48:33Z';
    const res = await request(createApp()).get('/api/me').set('Cookie', `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`);
    expect(res.body).toMatchObject({ email: 'klaus@klaushofrichter.net', buildDate: '2026-09-26T12:48:33.000Z' });
  });
});
