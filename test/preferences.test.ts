import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync, rmSync } from 'fs';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { DEFAULT_PREFERENCES } from '../server/preferences';
import { SESSION_COOKIE, signSession } from '../server/session';

const as = (email: string) => `${SESSION_COOKIE}=${signSession(email)}`;
const klaus = as('klaus@klaushofrichter.net');

beforeEach(() => {
  rmSync(process.env.PREFS_FILE!, { force: true });
  setCameras([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]);
});

describe('preferences', () => {
  it('returns defaults when nothing is stored', async () => {
    const res = await request(createApp()).get('/api/preferences').set('Cookie', klaus);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_PREFERENCES);
  });

  it('saves a partial update, merges it and persists it to the file', async () => {
    const res = await request(createApp()).put('/api/preferences').set('Cookie', klaus).send({ liveQuality: 'main', timelineZoom: 6 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...DEFAULT_PREFERENCES, liveQuality: 'main', timelineZoom: 6 });
    const file = JSON.parse(readFileSync(process.env.PREFS_FILE!, 'utf8'));
    expect(file['klaus@klaushofrichter.net'].liveQuality).toBe('main');
    const again = await request(createApp()).get('/api/preferences').set('Cookie', klaus);
    expect(again.body.timelineZoom).toBe(6);
  });

  it.each([
    [{ liveQuality: 'ultra' }],
    [{ timelineZoom: 12 }],
    [{ eventFilter: 'cat' }],
    [{ defaultCamera: 'nope' }],
    [{ theme: 'dark' }],
    [{ liveKeepAlive: 45 }],
    [{ liveKeepAlive: -1 }],
  ])('rejects %j', async (body) => {
    const res = await request(createApp()).put('/api/preferences').set('Cookie', klaus).send(body);
    expect(res.status).toBe(400);
  });

  it('accepts a configured camera and null as the default camera', async () => {
    const put = (defaultCamera: string | null) =>
      request(createApp()).put('/api/preferences').set('Cookie', klaus).send({ defaultCamera });
    expect((await put('cam1')).body.defaultCamera).toBe('cam1');
    expect((await put(null)).body.defaultCamera).toBeNull();
  });

  it('survives a corrupted file by falling back to defaults', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(process.env.PREFS_FILE!, '{not json');
    const res = await request(createApp()).get('/api/preferences').set('Cookie', klaus);
    expect(res.body).toEqual(DEFAULT_PREFERENCES);
  });
});
