import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('error handler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers a malformed URI with 400 text/plain and writes nothing to stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = await request(createApp()).get('/%E0%A4%A');
    expect(res.status).toBe(400);
    expect(res.type).toBe('text/plain');
    expect(res.text).not.toContain('/Users/');
    expect(res.text).not.toContain('at ');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('answers a missing asset with 404 and no path in the body', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = await request(createApp()).get('/assets/nope.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('/assets/nope.js');
    expect(res.text).not.toContain('/Users/');
    expect(res.text).not.toContain('at ');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('answers a traversal attempt without leaking the stack', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = await request(createApp()).get('/assets/..%2fapp.html');
    expect(res.text).not.toContain('/Users/');
    expect(res.text).not.toContain('at ');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('answers bad JSON on a POST to /api/me with 400 JSON and no stack', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = await request(createApp())
      .post('/api/me')
      .set('Cookie', auth)
      .set('Host', 'cams.test')
      .set('Origin', 'http://cams.test')
      .set('Content-Type', 'application/json')
      .send('{not valid json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad request' });
    expect(JSON.stringify(res.body)).not.toContain('/Users/');
    expect(JSON.stringify(res.body)).not.toContain('at ');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
