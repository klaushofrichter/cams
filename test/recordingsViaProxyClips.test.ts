import { setTimeout as sleep } from 'timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { getRecordings, resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, type SimCameraOptions, type SimState } from './camera/sim';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { recordingOf, seedRecordings } from './proxy/seedRecordings';
import * as proxyRecordings from '../server/recordings/proxyRecordings';

// The real client, spied on so one test can hand withClip a body that ends
// cleanly but short (HTTP itself can't send that through the fake).
vi.mock('../server/recordings/proxyRecordings', async (orig) => {
  const actual = await orig<typeof import('../server/recordings/proxyRecordings')>();
  return { ...actual, openProxyRecording: vi.fn(actual.openProxyRecording) };
});

// Spec 2026-10-02: playback and the clip-based thumbnails of a camera with a
// cam-proxy come from the proxy's recordings API, then its FTP copy, then the
// camera's own download behind the breaker. The proxy's still stays first
// for thumbnails.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CLIP = Buffer.from('ftp copy bytes '.repeat(100));
const STILL = Buffer.concat([JPEG, Buffer.from('still-at-start-plus-2s')]);

let cam: Server;
let state: SimState;
let fake: FakeProxy;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;

async function startCamera(opts: Partial<SimCameraOptions> = {}) {
  const sim = await createSimCamera({ user: 'u', password: 'p', ...opts });
  state = sim.state;
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  const host = `127.0.0.1:${(cam.address() as AddressInfo).port}`;
  setCameras([
    { id: 'cam1', name: 'Den', host, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } },
    { id: 'porch', name: 'Porch', host, protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetClients();
  resetProxyClients();
  resetRecordings();
}

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-viaproxy-clips-'));
  process.env.CACHE_DIR = cacheDir;
  fake = await startFakeProxy();
  await startCamera();
});
afterEach(async () => {
  vi.mocked(proxyRecordings.openProxyRecording).mockClear();
  await new Promise<void>((r) => cam.close(() => r()));
  await fake.stop();
  setCameras([]);
  process.env.CACHE_DIR = workerCacheDir;
  rmSync(cacheDir, { recursive: true, force: true });
});

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
type Day = { events: { id: string; start: string; end: string }[]; downloads: string };
const events = async (id = 'cam1') => (await request(createApp()).get(`/api/cameras/${id}/events?date=${today()}`).set('Cookie', auth)).body as Day;
const video = (id: string, camera = 'cam1') => request(createApp()).get(`/api/cameras/${camera}/clips/${id}/video`).set('Cookie', auth);
const thumb = (id: string) => request(createApp()).get(`/api/cameras/cam1/clips/${id}/thumb.jpg`).set('Cookie', auth);
const ftpCopy = (start: string) => fake.clips.push({ id: 5, cam: 'cam1', start: Date.parse(start) - 1000, end: Date.parse(start) + 30_000, stream: 'sub', events: [], body: CLIP });
const askedFtp = () => fake.requests.some((q) => q.path.endsWith('/clips') || /\/clips\/\d+\.mp4$/.test(q.path));

// The day listed from the proxy (the seeded recordings), and its first event.
async function seeded(body?: (stream: 'sub' | 'main', id: string) => Buffer) {
  const list = await seedRecordings(fake, 'cam1', today(), body);
  const day = await events();
  return { list, day, ev: day.events[0] };
}

// A short real MP4, so ffmpeg can make a thumbnail from it.
function mp4(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'cams-sd-mp4-'));
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'sd.mp4')]);
  const out = readFileSync(join(dir, 'sd.mp4'));
  rmSync(dir, { recursive: true, force: true });
  return out;
}

describe('playback and thumbnails through cam-proxy’s recordings', () => {
  it('plays the SD file from the proxy: no FTP copy, no camera download', async () => {
    const { list, ev } = await seeded();
    ftpCopy(ev.start);
    const r = await binary(video(ev.id));
    expect(r.status).toBe(200);
    const sub = recordingOf(list, ev.id, 'sub');
    expect(Buffer.compare(r.body, sub.body)).toBe(0);
    expect(fake.recordingFetches).toEqual([sub.id]);
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  it.each([
    [502, 'recordings_unavailable'],
    [503, 'camera_offline'],
  ])('plays the FTP copy when the proxy’s recordings answer %i', async (status, error) => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status, body: { error } };
    const r = await binary(video(ev.id));
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    expect(state.downloads).toBe(0);
    expect(getRecordings().downloadsState('cam1')).toBe('proxy');
  });

  // Review focus 2: the list came from the proxy (bare file names).
  it('then the camera, finding the file’s folder with the camera’s Search', async () => {
    const { ev } = await seeded();
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const searches = state.searches;
    const r = await binary(video(ev.id));
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(state.downloads).toBe(1);
    expect(state.searches).toBe(searches + 1);
  });

  it('answers unknown_clip for a recording gone from the SD card, with no fallback', async () => {
    const { list, ev } = await seeded();
    ftpCopy(ev.start);
    const subId = recordingOf(list, ev.id, 'sub').id;
    fake.recordings.set('cam1', list.filter((r) => r.id !== subId));
    const r = await video(ev.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'unknown_clip' });
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  // Review focus 5: nothing was sent to the viewer yet (the file goes to cams' cache first).
  it('falls back to the FTP copy when the proxy’s transfer drops midway', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingDropAfter = 100;
    const r = await binary(video(ev.id));
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
  });

  it('makes thumbnails from the proxy’s still first, without fetching a recording', async () => {
    const { ev } = await seeded();
    fake.stills.set('cam1', new Map([[Date.parse(ev.start) + 2000, STILL]]));
    const r = await binary(thumb(ev.id));
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body, STILL)).toBe(0);
    expect(fake.recordingFetches).toEqual([]);
  });

  it('without a still, makes the thumbnail from the SD file the proxy fetched', async () => {
    const sd = mp4();
    const { list, ev } = await seeded(() => sd);
    const r = await binary(thumb(ev.id));
    expect(r.status).toBe(200);
    expect([...r.body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(fake.recordingFetches).toContain(recordingOf(list, ev.id, 'sub').id);
    expect(state.downloads).toBe(0);
  }, 20_000);

  // Final review, minor 1: the proxy runs one transfer per camera, FIFO, so
  // cams lets at most one thumbnail's recording wait there ahead of a playback.
  it('sends the proxy one thumbnail recording at a time, and a playback goes ahead of the rest', async () => {
    const { list, day } = await seeded();
    expect(day.events.length).toBeGreaterThanOrEqual(4);
    const [play, ...rest] = day.events;
    const thumbs = rest.slice(0, 3);
    const thumbIds = new Set(thumbs.map((e) => recordingOf(list, e.id, 'sub').id));
    const playId = recordingOf(list, play.id, 'sub').id;
    let lowInFlight = 0;
    let maxLowInFlight = 0;
    const real = vi.mocked(proxyRecordings.openProxyRecording).getMockImplementation()!;
    vi.mocked(proxyRecordings.openProxyRecording).mockImplementation(async (cameraId, id, ...more) => {
      const low = thumbIds.has(id);
      if (low) maxLowInFlight = Math.max(maxLowInFlight, ++lowInFlight);
      try {
        return await real(cameraId, id, ...more);
      } finally {
        if (low) lowInFlight--;
      }
    });
    fake.recordingDelayMs = 300;
    try {
      const pending = thumbs.map((e) => thumb(e.id).then((r) => r.status));
      await sleep(100);
      const r = await binary(video(play.id));
      expect(r.status).toBe(200);
      // The playback reached the proxy behind at most the one thumbnail in flight.
      expect(fake.recordingFetches.indexOf(playId)).toBeLessThanOrEqual(1);
      await Promise.all(pending);
      expect(maxLowInFlight).toBe(1);
      expect(fake.recordingFetches.filter((id) => thumbIds.has(id)).length).toBe(3);
    } finally {
      vi.mocked(proxyRecordings.openProxyRecording).mockImplementation(real);
    }
  }, 20_000);

  it('serves a proxy recording while the camera’s transfer slot is busy', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ downloadDelayMs: 3000 });
    const { list, day } = await seeded();
    const [a, b] = day.events;
    // a: the proxy fails, so the camera (3 s per download) holds the slot.
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const slow = video(a.id).then((r) => r);
    await sleep(300);
    fake.recordingsOverride = null;
    const t0 = Date.now();
    const fast = await binary(video(b.id));
    expect(Buffer.compare(fast.body, recordingOf(list, b.id, 'sub').body)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await slow).status).toBe(200);
  }, 20_000);

  // Pre-flight ruling 3: a body shorter than its size is a failed transfer.
  it('falls back to the FTP copy when the proxy’s file ends short of its size', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    vi.mocked(proxyRecordings.openProxyRecording).mockResolvedValueOnce({ stream: Readable.from([Buffer.from('short')]), size: 1000 });
    const r = await binary(video(ev.id));
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    expect(getRecordings().downloadsState('cam1')).toBe('proxy');
  });

  // Task 3 handoff: a day listed by the camera's own Search holds camera
  // paths (the proxy's list failed then); the proxy is asked for the bare name.
  it('asks the proxy for the bare file name when the day came from the camera’s Search', async () => {
    const list = await seedRecordings(fake, 'cam1', today());
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const ev = (await events()).events[0];
    fake.recordingsOverride = null;
    const sub = recordingOf(list, ev.id, 'sub');
    const r = await binary(video(ev.id));
    expect(Buffer.compare(r.body, sub.body)).toBe(0);
    expect(fake.recordingFetches).toEqual([sub.id]);
    expect(state.downloads).toBe(0);
  });

  it('downloads a camera path from the camera without another Search', async () => {
    await seedRecordings(fake, 'cam1', today());
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const ev = (await events()).events[0];
    const searches = state.searches;
    const r = await binary(video(ev.id));
    expect(r.status).toBe(200);
    expect(state.downloads).toBe(1);
    expect(state.searches).toBe(searches);
  });

  it('leaves a camera without a cam-proxy unchanged: the camera’s download', async () => {
    const day = await events('porch');
    const r = await video(day.events[0].id, 'porch');
    expect(r.status).toBe(200);
    expect(state.downloads).toBe(1);
    expect(fake.requests).toEqual([]);
  });
});

// Review of Task 4: the camera Search that finds a bare name's folder runs
// after the breaker check, outside the transfer slot, once per day, and an
// empty answer (it may have overlapped the proxy's Search) isn't final.
describe('finding a bare name’s folder on the camera', () => {
  const yesterday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() - 86_400_000));

  it('runs no Search while the breaker is open, and answers as before', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ dropFirstDownloads: 1000 });
    await seedRecordings(fake, 'cam1', today());
    // A day from the camera's Search (paths): three refusals open the breaker.
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const ev = (await events()).events[0];
    for (let i = 0; i < 3; i++) expect((await video(ev.id)).status).toBe(503);
    // The day again from the proxy (bare names); its file transfer fails.
    await getRecordings().invalidateAround('cam1', Date.now());
    fake.recordingsOverride = null;
    fake.recordingDropAfter = 0;
    expect((await events()).events[0].id).toBe(ev.id);
    const searches = state.searches;
    const downloads = state.downloads;
    const r = await video(ev.id);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'recordings_unavailable' });
    expect(state.searches).toBe(searches);
    expect(state.downloads).toBe(downloads);
  });

  it('leaves the transfer slot free while it searches', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ searchDelayMs: 2000 }); // the demo clips: today and yesterday
    await seedRecordings(fake, 'cam1', today());
    const a = (await events()).events[0]; // today: bare names, from the proxy
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const b = ((await request(createApp()).get(`/api/cameras/cam1/events?date=${yesterday()}`).set('Cookie', auth)).body as Day).events[0]; // yesterday: paths, from the camera's Search
    const slow = video(a.id).then((r) => r);
    await sleep(300);
    const t0 = Date.now();
    expect((await video(b.id)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await slow).status).toBe(200);
  }, 30_000);

  it('searches once for two fallbacks on the same day', async () => {
    const { day } = await seeded();
    const [a, b] = day.events;
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const searches = state.searches;
    expect((await video(a.id)).status).toBe(200);
    expect((await video(b.id)).status).toBe(200);
    expect(state.downloads).toBe(2);
    expect(state.searches).toBe(searches + 1);
  });

  it('answers recordings_unavailable, not unknown_clip, when the Search comes back empty', async () => {
    await seedRecordings(fake, 'cam1', today());
    // The camera now lists nothing (as when its Search overlaps another).
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ clips: [] });
    const ev = (await events()).events[0];
    fake.recordingDropAfter = 0;
    const r = await video(ev.id);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'recordings_unavailable' });
  });
});
