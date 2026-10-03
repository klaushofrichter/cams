import { setTimeout as sleep } from 'timers/promises';
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
import { getRecordings, resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, type SimState } from './camera/sim';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

// Plan 7 (Klaus, 2026-09-27): for a camera with a cam-proxy, clips and
// thumbnails come from the proxy first; the camera is asked only when the
// proxy has nothing (and for full-quality downloads).
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CLIP = Buffer.from('proxy sub clip '.repeat(200));
const STILL = Buffer.concat([JPEG, Buffer.from('still-at-start-plus-2s')]);

let cam: Server;
let state: SimState;
let fake: FakeProxy;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-proxyfirst-'));
  process.env.CACHE_DIR = cacheDir;
  const sim = await createSimCamera({ user: 'u', password: 'p' }); // downloads work
  state = sim.state;
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
  rmSync(cacheDir, { recursive: true, force: true });
});

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

async function firstEvent(app: ReturnType<typeof createApp>) {
  const body = (await request(app).get(`/api/cameras/cam1/events?date=${today()}`).set('Cookie', auth)).body as { events: { id: string; start: string; end: string }[]; downloads: string };
  return { ev: body.events[0], downloads: body.downloads };
}

describe('proxy first (Plan 7)', () => {
  it('plays the proxy’s clip without asking the camera', async () => {
    const app = createApp();
    const { ev, downloads } = await firstEvent(app);
    expect(downloads).toBe('proxy');
    const start = Date.parse(ev.start);
    fake.clips.push({ id: 5, cam: 'cam1', start: start - 4000, end: start + 30_000, stream: 'sub', events: [], body: CLIP });
    const r = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/video`).set('Cookie', auth));
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    expect(state.downloads).toBe(0);
  });

  // Issue #76: the dialog tells "no copy" from "could not ask".
  it('finds the proxy clip for composing: null when it has none, an error when the proxy fails', async () => {
    const { ev } = await firstEvent(createApp());
    expect(await getRecordings().proxyClipOf('cam1', ev.id)).toBeNull();
    fake.offline = true;
    await expect(getRecordings().proxyClipOf('cam1', ev.id)).rejects.toThrow();
  });

  it('asks the camera when the proxy has no clip for the event', async () => {
    const app = createApp();
    const { ev } = await firstEvent(app);
    const r = await request(app).get(`/api/cameras/cam1/clips/${ev.id}/video`).set('Cookie', auth);
    expect(r.status).toBe(200);
    expect(state.downloads).toBe(1);
  });

  it('downloads full quality from the camera, the sub stream from the proxy', async () => {
    const app = createApp();
    const { ev } = await firstEvent(app);
    const start = Date.parse(ev.start);
    fake.clips.push({ id: 6, cam: 'cam1', start: start - 4000, end: start + 30_000, stream: 'sub', events: [], body: CLIP });
    const main = await request(app).get(`/api/cameras/cam1/clips/${ev.id}/download?quality=main`).set('Cookie', auth);
    expect(main.status).toBe(200);
    expect(main.headers['content-disposition']).toMatch(/-main\.mp4"$/);
    expect(state.downloads).toBe(1);
    const sub = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/download?quality=sub`).set('Cookie', auth));
    expect(sub.headers['content-disposition']).toMatch(/-proxy\.mp4"$/);
    expect(Buffer.compare(sub.body, CLIP)).toBe(0);
    expect(state.downloads).toBe(1);
  });

  // Review I3: the proxy's clip doesn't wait for the camera's one transfer
  // slot (a slow camera download elsewhere).
  it('serves a proxy clip while the camera’s transfer slot is busy', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    const sim = await createSimCamera({ user: 'u', password: 'p', downloadDelayMs: 3000 });
    state = sim.state;
    cam = sim.app.listen(0);
    await new Promise((r) => cam.once('listening', r));
    setCameras([{ id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } }]);
    resetClients();
    resetRecordings();
    const app = createApp();
    const body = (await request(app).get(`/api/cameras/cam1/events?date=${today()}`).set('Cookie', auth)).body as { events: { id: string; start: string }[] };
    const [a, b] = body.events;
    fake.clips.push({ id: 9, cam: 'cam1', start: Date.parse(b.start) - 1000, end: Date.parse(b.start) + 20_000, stream: 'sub', events: [], body: CLIP });
    // a: no proxy clip, so the camera (3 s per download) holds the slot.
    const slow = request(app).get(`/api/cameras/cam1/clips/${a.id}/video`).set('Cookie', auth).then((r) => r);
    await sleep(200);
    const t0 = Date.now();
    const fast = await binary(request(app).get(`/api/cameras/cam1/clips/${b.id}/video`).set('Cookie', auth));
    expect(Buffer.compare(fast.body, CLIP)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    await slow;
  }, 20_000);

  // Review M1: only a JPEG becomes a cached thumbnail.
  it('falls back to the clip when the proxy’s still isn’t a JPEG', async () => {
    const app = createApp();
    const { ev } = await firstEvent(app);
    const start = Date.parse(ev.start);
    fake.stills.set('cam1', new Map([[start + 2000, Buffer.from('<html>not an image</html>')]]));
    const r = await request(app).get(`/api/cameras/cam1/clips/${ev.id}/thumb.jpg`).set('Cookie', auth);
    expect(r.status).toBe(200);
    expect(state.downloads).toBe(1); // the clip path made it
  });

  it('makes the event thumbnail from the proxy’s still 2 s into the event, without any clip', async () => {
    const app = createApp();
    const { ev } = await firstEvent(app);
    const start = Date.parse(ev.start);
    fake.stills.set('cam1', new Map([[start + 1000, JPEG], [start + 2000, STILL], [start + 3000, JPEG]]));
    const r = await binary(request(app).get(`/api/cameras/cam1/clips/${ev.id}/thumb.jpg`).set('Cookie', auth));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(r.body, STILL)).toBe(0);
    expect(state.downloads).toBe(0);
    expect(fake.requests.some((q) => q.path.includes('/clips/'))).toBe(false);
  });
});
