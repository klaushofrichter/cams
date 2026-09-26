import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import http from 'http';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createMockCamera, MockState } from './mock-camera/server';
import * as thumbnailModule from '../server/recordings/thumbnail';

// Partial mock: real implementation by default, so every test except the
// one below (fix round 1, item 8) exercises the actual ffmpeg wrapper.
vi.mock('../server/recordings/thumbnail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/recordings/thumbnail')>();
  return { ...actual };
});

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
let cam: Server;
let state: MockState;

// This file's clip ids are deterministic (today's mock clips), so a clip
// cached by one test would otherwise satisfy fill() for a later test with no
// camera download, breaking the "exactly N downloads" assertions below.
// process.env.CACHE_DIR is set per-worker in test/setup.ts (fix round 1,
// item 11), so clearing it here only affects this file's own tests.
beforeEach(() => rmSync(process.env.CACHE_DIR!, { recursive: true, force: true }));

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

// Swaps the running mock camera for a fresh one (with different options,
// e.g. a download delay), keeping cam1 pointed at it. Closes the old one.
async function replaceMockCamera(opts: Parameters<typeof createMockCamera>[0]): Promise<void> {
  await new Promise<void>((r) => cam.close(() => r()));
  const mock = createMockCamera(opts);
  state = mock.state;
  cam = mock.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  setCameras([{ id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' }]);
  resetClients();
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

  // Fix round 1, item 10: the regex lets calendar nonsense through; a real
  // date/month check is needed on top of it.
  it('rejects well-formed but non-existent dates and months with 400', async () => {
    const app = createApp();
    expect((await request(app).get('/api/cameras/cam1/events?date=2026-13-40').set('Cookie', auth)).status).toBe(400);
    expect((await request(app).get('/api/cameras/cam1/events?date=2026-02-30').set('Cookie', auth)).status).toBe(400);
    expect((await request(app).get('/api/cameras/cam1/days?month=2026-13').set('Cookie', auth)).status).toBe(400);
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

  // Fix round 1, item 3: a client that goes away mid sendFile() must not
  // hang the request or crash the server.
  it('does not hang or crash when a client disconnects mid video response', async () => {
    const e = await firstClip();
    const app = createApp();
    // Warm the cache so this request's sendFile() serves straight from disk
    // (no camera round trip to race against).
    await request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: `/api/cameras/cam1/clips/${e.id}/video`, headers: { Cookie: auth } },
        (res) => {
          // Headers arrived; destroy the client socket right away so the
          // server's write to it fails mid-stream (headersSent === true).
          res.destroy();
          resolve();
        },
      );
      req.on('error', () => resolve());
      setTimeout(() => reject(new Error('response never arrived')), 5000);
    });
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((r) => server.close(() => r()));
    // The server (and this app instance) must still be healthy afterwards.
    const ok = await request(createApp()).get('/api/me').set('Cookie', auth);
    expect(ok.status).toBe(200);
  });

  // Fix round 1, item 4: pinned before fill() starts (inside withClip), so
  // the file being served can never be evicted mid-response. Exercised
  // end-to-end by forcing a tiny cache while a second clip's video is
  // fetched concurrently with the first still being served.
  it('does not evict a clip\'s video while it is still being served', async () => {
    process.env.CACHE_MAX_BYTES = '1'; // any single cached file exceeds this
    resetRecordings();
    try {
      const events = (await request(createApp()).get(`/api/cameras/cam1/events?date=${today()}`).set('Cookie', auth)).body.events;
      const app = createApp();
      const first = request(app).get(`/api/cameras/cam1/clips/${events[0].id}/video`).set('Cookie', auth);
      // Give the first request a moment to start (and pin its file) before
      // a second clip's fetch would otherwise be tempted to evict it.
      await new Promise((r) => setTimeout(r, 5));
      const second = request(app).get(`/api/cameras/cam1/clips/${events[1].id}/video`).set('Cookie', auth);
      const [r1, r2] = await Promise.all([first, second]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    } finally {
      delete process.env.CACHE_MAX_BYTES;
      resetRecordings();
    }
  });

  it('makes a JPEG thumbnail', async () => {
    const e = await firstClip();
    const res = await request(createApp()).get(`/api/cameras/cam1/clips/${e.id}/thumb.jpg`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  // Fix round 1, item 5: the mp4 is only fetched when the jpg isn't already
  // cached.
  it('serves a cached thumbnail without re-fetching the video', async () => {
    const e = await firstClip();
    const app = createApp();
    await request(app).get(`/api/cameras/cam1/clips/${e.id}/thumb.jpg`).set('Cookie', auth);
    expect(state.downloads).toBe(1);
    // Simulate the mp4 having been evicted while the jpg survived.
    rmSync(join(process.env.CACHE_DIR!, `cam1_${e.id}.mp4`), { force: true });
    const res = await request(app).get(`/api/cameras/cam1/clips/${e.id}/thumb.jpg`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(state.downloads).toBe(1); // no new camera download
  });

  // Fix round 1, item 8: ffmpeg exiting 0 but writing an empty file must be
  // treated as a failure, and nothing gets cached from it.
  it('rejects an empty thumbnail and does not cache it', async () => {
    const e = await firstClip();
    const app = createApp();
    const spy = vi.spyOn(thumbnailModule, 'makeThumbnail').mockImplementationOnce(async (_input: string, output: string) => {
      writeFileSync(output, Buffer.alloc(0));
    });
    const bad = await request(app).get(`/api/cameras/cam1/clips/${e.id}/thumb.jpg`).set('Cookie', auth);
    expect(bad.status).toBe(503);
    expect(bad.body).toEqual({ error: 'thumbnail_unavailable' });
    spy.mockRestore();
    const ok = await request(app).get(`/api/cameras/cam1/clips/${e.id}/thumb.jpg`).set('Cookie', auth);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
  });

  it('streams a full-quality download as an attachment with a readable name', async () => {
    const e = await firstClip();
    const res = await request(createApp()).get(`/api/cameras/cam1/clips/${e.id}/download?quality=main`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="cam1-${today()}_08-15-10-main.mp4"`);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  // Fix round 1, item 9: an invalid quality is 400, a missing quality
  // defaults to sub, and the camera's content-length is forwarded.
  it('rejects an invalid download quality and defaults a missing one to sub', async () => {
    const e = await firstClip();
    const app = createApp();
    const bad = await request(app).get(`/api/cameras/cam1/clips/${e.id}/download?quality=ultra`).set('Cookie', auth);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'bad_request' });
    const res = await request(app).get(`/api/cameras/cam1/clips/${e.id}/download`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="cam1-${today()}_08-15-10-sub.mp4"`);
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
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

  // Fix round 1, item 2: a client that disconnects mid-download must free
  // its camera transfer slot rather than leaking it.
  it('frees the camera transfer slot when a client disconnects mid-download', async () => {
    const e = await firstClip();
    await replaceMockCamera({ user: 'u', password: 'p', downloadDelayMs: 150 });
    const app = createApp();
    const abort = (): Promise<void> => {
      const test = request(app).get(`/api/cameras/cam1/clips/${e.id}/download`).set('Cookie', auth);
      const done = test.then(() => {}).catch(() => {});
      setTimeout(() => test.abort(), 20);
      return done;
    };
    // TRANSFERS_PER_CAMERA is 2: both of these occupy the whole gate.
    await Promise.all([abort(), abort()]);
    await new Promise((r) => setTimeout(r, 100));
    expect(state.activeDownloads).toBe(0);
    // The gate must be free again: a third download completes normally.
    const res = await request(app).get(`/api/cameras/cam1/clips/${e.id}/download`).set('Cookie', auth);
    expect(res.status).toBe(200);
  });

  // Fix round 1, item 2: the camera dropping the connection mid-transfer
  // must not crash the process; the response just ends.
  it('does not crash the process when the camera drops the connection mid-download', async () => {
    const e = await firstClip();
    const app = createApp();
    const pending = request(app).get(`/api/cameras/cam1/clips/${e.id}/download?quality=main`).set('Cookie', auth);
    const settled = pending.then((r) => r).catch((err) => err);
    await new Promise((r) => setTimeout(r, 20));
    state.dropDownloads();
    await settled;
    // The process (and this app instance) must still be healthy afterwards.
    const ok = await request(createApp()).get('/api/me').set('Cookie', auth);
    expect(ok.status).toBe(200);
  });
});
