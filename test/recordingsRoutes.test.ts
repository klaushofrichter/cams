import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { rmSync } from 'fs';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createMockCamera, MockState } from './mock-camera/server';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
let cam: Server;
let state: MockState;

// Deviation from the brief: the shared test/setup.ts only clears CACHE_DIR
// once (beforeAll), which is right for every other test file, but this
// file's clip ids are deterministic (today's mock clips), so a clip cached
// by one test satisfies fill() for a later test with no camera download,
// breaking the "exactly one download" assertions below. Clearing the cache
// directory here, scoped to this file's own beforeEach, fixes that without
// racing other test files that run concurrently in other workers.
beforeEach(() => rmSync('/tmp/cams-test-cache', { recursive: true, force: true }));

beforeEach(async () => {
  const mock = createMockCamera({ user: 'u', password: 'p' });
  state = mock.state;
  cam = mock.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  setCameras([
    { id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' },
    { id: 'cam2', name: 'Other', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetClients();
  resetRecordings();
});
afterEach(async () => {
  await new Promise<void>((r) => cam.close(() => r()));
  setCameras([]);
});

async function firstClip(date = today()) {
  const res = await request(createApp()).get(`/api/cameras/cam1/events?date=${date}`).set('Cookie', auth);
  return res.body.events[0];
}

describe('recordings API', () => {
  it('lists today\'s events with exact times, triggers and sizes', async () => {
    const res = await request(createApp()).get(`/api/cameras/cam1/events?date=${today()}`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { triggers: string[] }) => e.triggers)).toEqual([['person'], ['vehicle'], ['motion'], ['pet']]);
    const e = res.body.events[0];
    expect(e.id).toMatch(/^\d{8}-081510-081535$/);
    expect(e.start).toMatch(new RegExp(`^${today()}T08:15:10-0[56]:00$`));
    expect(e.durationSec).toBe(25);
    expect(e.sizeSub).toBeGreaterThan(0);
    expect(e.sizeMain).toBeGreaterThan(0);
  });

  // Review focus 5: an empty day is an empty list, not an error.
  it('returns an empty list for a day without recordings', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/events?date=2001-01-01').set('Cookie', auth);
    expect(res.body).toEqual({ date: '2001-01-01', events: [] });
  });

  it('lists days with recordings in a month', async () => {
    const res = await request(createApp()).get(`/api/cameras/cam1/days?month=${today().slice(0, 7)}`).set('Cookie', auth);
    expect(res.body.days).toContain(today());
  });

  it('rejects malformed dates, months and clip ids with 400', async () => {
    const app = createApp();
    expect((await request(app).get('/api/cameras/cam1/events?date=2026-9-1').set('Cookie', auth)).status).toBe(400);
    expect((await request(app).get('/api/cameras/cam1/days?month=202609').set('Cookie', auth)).status).toBe(400);
    expect((await request(app).get('/api/cameras/cam1/clips/..%2F..%2Fetc/video').set('Cookie', auth)).status).toBe(400);
    expect((await request(app).get('/api/cameras/cam1/clips/not-a-clip/thumb.jpg').set('Cookie', auth)).status).toBe(400);
  });

  // Review focus 1: a well-formed id that this camera never listed is unknown.
  it('404s a well-formed clip id the camera never listed', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/clips/20010101-000000-000010/video').set('Cookie', auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_clip' });
  });

  it('serves the clip as seekable MP4 with Range support, fetching it from the camera once', async () => {
    const e = await firstClip();
    const app = createApp();
    const full = await request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth).set('Range', 'bytes=0-99');
    expect(part.status).toBe(206);
    expect(part.headers['content-length']).toBe('100');
    expect(state.downloads).toBe(1);
  });

  // Review focus 2: concurrent first requests share one camera transfer.
  it('shares one camera download between concurrent first requests for a clip', async () => {
    const e = await firstClip();
    const app = createApp();
    await Promise.all([1, 2, 3].map(() => request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth)));
    expect(state.downloads).toBe(1);
  });

  it('makes a JPEG thumbnail', async () => {
    const e = await firstClip();
    const res = await request(createApp()).get(`/api/cameras/cam1/clips/${e.id}/thumb.jpg`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('streams a full-quality download as an attachment with a readable name', async () => {
    const e = await firstClip();
    const res = await request(createApp()).get(`/api/cameras/cam1/clips/${e.id}/download?quality=main`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="cam1-${today()}_08-15-10-main.mp4"`);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('never lets one camera\'s id reach another camera\'s cache entry', async () => {
    const e = await firstClip();
    const app = createApp();
    await request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth);
    // cam2 must fetch its own copy rather than reuse cam1's file.
    await request(app).get(`/api/cameras/cam2/clips/${e.id}/video`).set('Cookie', auth);
    expect(state.downloads).toBe(2);
  });

  it('requires a session', async () => {
    expect((await request(createApp()).get(`/api/cameras/cam1/events?date=${today()}`)).status).toBe(401);
  });
});
