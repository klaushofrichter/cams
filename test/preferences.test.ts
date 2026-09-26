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
    [{ toString: 'x' }],
    [{ constructor: 'x' }],
    [JSON.parse('{"__proto__":{"polluted":true}}')],
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

  it('drops stored fields that are unknown or no longer valid', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(
      process.env.PREFS_FILE!,
      JSON.stringify({ 'klaus@klaushofrichter.net': { liveQuality: 'nonsense', timelineZoom: 6, extraOldField: 'legacy', defaultCamera: 'removed-cam' } }),
    );
    const res = await request(createApp()).get('/api/preferences').set('Cookie', klaus);
    expect(res.body).toEqual({ ...DEFAULT_PREFERENCES, timelineZoom: 6 });
  });

  it('leaves no temp file behind when a save fails', async () => {
    const { mkdtempSync, readdirSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { savePreferences } = await import('../server/preferences');
    const dir = mkdtempSync(join(tmpdir(), 'cams-prefs-fail-'));
    const saved = process.env.PREFS_FILE;
    process.env.PREFS_FILE = dir; // a directory: the rename onto it fails
    try {
      await expect(savePreferences('klaus@klaushofrichter.net', { timelineZoom: 6 })).rejects.toThrow();
      expect(readdirSync(join(dir, '..')).filter((n) => n.startsWith(`${dir.split('/').pop()}.tmp-`))).toEqual([]);
    } finally {
      process.env.PREFS_FILE = saved;
      rmSync(dir, { recursive: true, force: true });
    }
    // a later save still works
    await expect(savePreferences('klaus@klaushofrichter.net', { timelineZoom: 1 })).resolves.toMatchObject({ timelineZoom: 1 });
  });

  it('survives a corrupted file by falling back to defaults', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(process.env.PREFS_FILE!, '{not json');
    const res = await request(createApp()).get('/api/preferences').set('Cookie', klaus);
    expect(res.body).toEqual(DEFAULT_PREFERENCES);
  });

  // Saving over a corrupt file would replace every other user's preferences
  // with just this one's: refuse, and leave the file for a human to repair.
  it.each([['{not json'], ['[1, 2]']])('refuses to save over a corrupt file (%s)', async (content) => {
    const { writeFileSync } = await import('fs');
    writeFileSync(process.env.PREFS_FILE!, content);
    const res = await request(createApp()).put('/api/preferences').set('Cookie', klaus).send({ timelineZoom: 6 });
    expect(res.status).toBe(500);
    expect(readFileSync(process.env.PREFS_FILE!, 'utf8')).toBe(content);
  });
});
