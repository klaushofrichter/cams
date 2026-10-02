import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera } from './camera/sim';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

// Plan 6: the real camera refuses every recording download; with a
// cam-proxy, recordings play from the clips the camera uploaded to it.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CLIP = Buffer.from('proxy clip bytes '.repeat(100));
const OTHER = Buffer.from('another clip '.repeat(50));

let cam: Server;
let fake: FakeProxy;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-proxyclips-'));
  process.env.CACHE_DIR = cacheDir;
  process.env.RECORDINGS_PROBE_MS = '60000';
  const sim = await createSimCamera({ user: 'u', password: 'p', dropFirstDownloads: 1000 });
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  fake = await startFakeProxy();
  setCameras([
    { id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } },
  ]);
  resetClients();
  resetProxyClients();
  resetRecordings();
});
afterEach(async () => {
  await new Promise<void>((r) => cam.close(() => r()));
  await fake.stop();
  setCameras([]);
  process.env.CACHE_DIR = workerCacheDir;
  delete process.env.RECORDINGS_PROBE_MS;
  rmSync(cacheDir, { recursive: true, force: true });
});

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

async function events(app = createApp()) {
  const body = (await request(app).get(`/api/cameras/cam1/events?date=${today()}`).set('Cookie', auth)).body as { events: { id: string; start: string; end: string }[]; downloads: string };
  return body;
}

describe('recordings from cam-proxy clips', () => {
  it('plays the proxy clip covering the event when the camera refuses', async () => {
    const app = createApp();
    const [ev] = (await events(app)).events;
    const start = Date.parse(ev.start);
    fake.clips.push({ id: 11, cam: 'cam1', start: start - 4000, end: start + 60_000, stream: 'main', events: [], body: CLIP, snapshot: JPEG });
    const r = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/video`).set('Cookie', auth));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    // Seeking works on the cached copy.
    const part = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/video`).set('Cookie', auth).set('Range', 'bytes=0-9'));
    expect(part.status).toBe(206);
    expect(fake.requests.some((q) => q.path === '/api/cameras/cam1/clips/11.mp4')).toBe(true);
  });

  it('picks the clip that contains the event’s start among several', async () => {
    const app = createApp();
    const [ev] = (await events(app)).events;
    const start = Date.parse(ev.start);
    fake.clips.push({ id: 1, cam: 'cam1', start: start - 120_000, end: start - 30_000, stream: 'main', events: [], body: OTHER });
    fake.clips.push({ id: 2, cam: 'cam1', start: start - 2000, end: start + 30_000, stream: 'main', events: [], body: CLIP });
    fake.clips.push({ id: 3, cam: 'cam1', start: start + 40_000, end: start + 90_000, stream: 'main', events: [], body: OTHER });
    const r = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/video`).set('Cookie', auth));
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
  });

  // Final review C1: never another event's clip, which would be cached
  // under this event's key.
  it('never plays a clip that ended before the event, or one that starts later', async () => {
    const app = createApp();
    const [a, b] = (await events(app)).events;
    const startA = Date.parse(a.start);
    fake.clips.push({ id: 21, cam: 'cam1', start: startA - 50_000, end: startA - 10_000, stream: 'main', events: [], body: OTHER });
    expect((await request(app).get(`/api/cameras/cam1/clips/${a.id}/video`).set('Cookie', auth)).status).toBe(503);
    const startB = Date.parse(b.start);
    fake.clips.push({ id: 22, cam: 'cam1', start: startB + 20_000, end: startB + 80_000, stream: 'main', events: [], body: OTHER });
    expect((await request(app).get(`/api/cameras/cam1/clips/${b.id}/video`).set('Cookie', auth)).status).toBe(503);
  });

  it('allows a few seconds between the camera’s and the upload’s start times', async () => {
    const app = createApp();
    const [ev] = (await events(app)).events;
    const start = Date.parse(ev.start);
    fake.clips.push({ id: 23, cam: 'cam1', start: start + 2000, end: start + 30_000, stream: 'main', events: [], body: CLIP });
    const r = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/video`).set('Cookie', auth));
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
  });

  it('keeps the camera’s error when the proxy has no clip for the event, or is down', async () => {
    const app = createApp();
    const [a, b] = (await events(app)).events;
    expect((await request(app).get(`/api/cameras/cam1/clips/${a.id}/video`).set('Cookie', auth)).status).toBe(503);
    fake.clips.push({ id: 5, cam: 'cam1', start: Date.parse(b.start), end: Date.parse(b.end), stream: 'main', events: [], body: CLIP });
    fake.offline = true;
    expect((await request(app).get(`/api/cameras/cam1/clips/${b.id}/video`).set('Cookie', auth)).status).toBe(503);
  });

  it('reports downloads: proxy once the camera’s breaker is open', async () => {
    const app = createApp();
    const list = (await events(app)).events;
    for (const ev of list.slice(0, 3)) await request(app).get(`/api/cameras/cam1/clips/${ev.id}/video`).set('Cookie', auth);
    expect((await events(app)).downloads).toBe('proxy');
  });

  // Klaus, 2026-10-02: no silent quality downgrade. The camera refuses and
  // the proxy has no SD recordings (503): SD takes the FTP copy, 4K doesn't.
  it('serves the SD download from the proxy’s FTP copy, named as such, but never 4K', async () => {
    const app = createApp();
    const [ev] = (await events(app)).events;
    const start = Date.parse(ev.start);
    fake.clips.push({ id: 7, cam: 'cam1', start: start - 1000, end: start + 30_000, stream: 'main', events: [], body: CLIP });
    const r = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/download?quality=sub`).set('Cookie', auth));
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/-proxy\.mp4"$/);
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    const main = await request(app).get(`/api/cameras/cam1/clips/${ev.id}/download?quality=main`).set('Cookie', auth);
    expect(main.status).toBe(503);
    expect(main.body).toEqual({ error: 'full_quality_unavailable' });
  });

  // Issue #38 items.
  it('asks the proxy once when it has no clip and the camera refuses', async () => {
    const app = createApp();
    const [a] = (await events(app)).events;
    const before = fake.requests.filter((r) => r.path.endsWith('/clips')).length;
    expect((await request(app).get(`/api/cameras/cam1/clips/${a.id}/video`).set('Cookie', auth)).status).toBe(503);
    expect(fake.requests.filter((r) => r.path.endsWith('/clips')).length - before).toBe(1);
  });

  it('asks the proxy for at most three thumbnails at once', async () => {
    const app = createApp();
    const evs = (await events(app)).events;
    const stills = new Map<number, Buffer>();
    for (const e of evs) stills.set(Date.parse(e.start) + 3000, JPEG);
    fake.stills.set('cam1', stills);
    fake.stillDelayMs = 50;
    await Promise.all(evs.map((e) => request(app).get(`/api/cameras/cam1/clips/${e.id}/thumb.jpg`).set('Cookie', auth)));
    expect(evs.length).toBeGreaterThan(3);
    expect(fake.maxStillsInFlight).toBeGreaterThan(0);
    expect(fake.maxStillsInFlight).toBeLessThanOrEqual(3);
    // The lookups before the image too (issue #76).
    expect(fake.maxStillListsInFlight).toBeGreaterThan(0);
    expect(fake.maxStillListsInFlight).toBeLessThanOrEqual(3);
  });

  it('answers a thumbnail quickly and cleanly while the proxy is down and the camera refuses', async () => {
    const app = createApp();
    const [a] = (await events(app)).events;
    fake.offline = true;
    const t0 = Date.now();
    const r = await request(app).get(`/api/cameras/cam1/clips/${a.id}/thumb.jpg`).set('Cookie', auth);
    expect(r.status).toBe(503);
    expect(r.headers['content-type']).toMatch(/json/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
