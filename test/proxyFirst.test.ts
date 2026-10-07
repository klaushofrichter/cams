import { setTimeout as sleep } from 'timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { resetAiEventStore } from '../server/proxy/aiEvents';
import { resetCheckStore } from '../server/proxy/stillChecks';
import { proxyHub } from '../server/proxy/stream';
import { getRecordings, resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, type SimState } from './camera/sim';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { k } from './helpers/fleet';
import { fileSafe } from '../server/fleet';

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
  resetAiEventStore();
  resetCheckStore();
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
    expect(await getRecordings().proxyClipOf(k('cam1'), ev.id)).toBeNull();
    fake.offline = true;
    await expect(getRecordings().proxyClipOf(k('cam1'), ev.id)).rejects.toThrow();
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

  // Issue #157: a person, vehicle or pet card shows the second the camera's
  // AI saw it (cam-proxy's event start, or Vision's analysed still).
  describe('thumbnail from the detection moment', () => {
    const DET = Buffer.concat([JPEG, Buffer.from('still-at-the-detection')]);
    const ANALYSED = Buffer.concat([JPEG, Buffer.from('still-vision-analysed')]);
    async function card(app: ReturnType<typeof createApp>, trigger: string) {
      const body = (await request(app).get(`/api/cameras/cam1/events?date=${today()}`).set('Cookie', auth)).body as { events: { id: string; start: string; end: string; triggers: string[] }[] };
      const c = body.events.find((e) => e.triggers.includes(trigger))!;
      return { id: c.id, start: Date.parse(c.start), end: Date.parse(c.end) };
    }
    const thumb = (app: ReturnType<typeof createApp>, id: string) => binary(request(app).get(`/api/cameras/cam1/clips/${id}/thumb.jpg`).set('Cookie', auth));
    const event = (id: number, kind: string, start: number, analysis: unknown = null) => ({ id, kind, source: 'onvif', start, end: start + 5000, endReason: 'state', analysis });
    // The card's own lookup; the day's list asks per AI type (kind=…) for its counts.
    const eventLookups = () => fake.requests.filter((q) => q.path === '/api/cameras/cam1/events' && q.query.kind === undefined).length;

    it('uses the still at the first second a person was detected', async () => {
      const app = createApp();
      const c = await card(app, 'person');
      fake.events.set('cam1', [event(1, 'motion', c.start + 1000), event(2, 'person', c.start + 6000)]);
      fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 6000, DET]]));
      const r = await thumb(app, c.id);
      expect(r.status).toBe(200);
      expect(Buffer.compare(r.body, DET)).toBe(0);
      expect(state.downloads).toBe(0);
      // Cached: the next request asks the proxy nothing.
      const before = fake.requests.length;
      expect(Buffer.compare((await thumb(app, c.id)).body, DET)).toBe(0);
      expect(fake.requests.length).toBe(before);
      expect(eventLookups()).toBe(1);
    });

    it('prefers the still Vision analysed and confirmed the person on', async () => {
      const app = createApp();
      const c = await card(app, 'person');
      const analysis = { provider: 'google-vision', status: 'ok', reason: null, stillTs: c.start + 7000, objects: [], summary: [{ category: 'person', subtype: 'person', score: 0.86, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }] };
      fake.events.set('cam1', [event(2, 'person', c.start + 6000, analysis)]);
      fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 6000, DET], [c.start + 7000, ANALYSED]]));
      expect(Buffer.compare((await thumb(app, c.id)).body, ANALYSED)).toBe(0);
    });

    it('falls back to the still 2 s in when there is none at the detection (a gap)', async () => {
      const app = createApp();
      const c = await card(app, 'vehicle');
      fake.events.set('cam1', [event(3, 'vehicle', c.start + 6000)]);
      fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 20_000, DET]]));
      expect(Buffer.compare((await thumb(app, c.id)).body, STILL)).toBe(0);
    });

    it('falls back to the still 2 s in when the proxy has no events for the card (an old event)', async () => {
      const app = createApp();
      const c = await card(app, 'pet');
      fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 6000, DET]]));
      expect(Buffer.compare((await thumb(app, c.id)).body, STILL)).toBe(0);
    });

    it('falls back to the still 2 s in when the event lookup fails', async () => {
      const app = createApp();
      const c = await card(app, 'person');
      fake.events.set('cam1', [event(2, 'person', c.start + 6000)]);
      fake.eventsStatus = 500;
      fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 6000, DET]]));
      const r = await thumb(app, c.id);
      expect(r.status).toBe(200);
      expect(Buffer.compare(r.body, STILL)).toBe(0);
    });

    it('takes a still up to 3 s after the detection, not 4 s', async () => {
      const app = createApp();
      const p = await card(app, 'person');
      const v = await card(app, 'vehicle');
      fake.events.set('cam1', [event(2, 'person', p.start + 6000), event(3, 'vehicle', v.start + 6000)]);
      fake.stills.set('cam1', new Map([[p.start + 2000, STILL], [p.start + 8000, DET], [v.start + 2000, STILL], [v.start + 10_000, DET]]));
      expect(Buffer.compare((await thumb(app, p.id)).body, DET)).toBe(0); // + 2 s
      expect(Buffer.compare((await thumb(app, v.id)).body, STILL)).toBe(0); // + 4 s: the 2 s rule
    });

    it('serves the detection still, not a thumbnail cached before it (its own key)', async () => {
      const app = createApp();
      const c = await card(app, 'person');
      writeFileSync(join(cacheDir, `${fileSafe(k('cam1'))}_${c.id}.jpg`), Buffer.concat([JPEG, Buffer.from('old-thumbnail')]));
      fake.events.set('cam1', [event(2, 'person', c.start + 6000)]);
      fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 6000, DET]]));
      expect(Buffer.compare((await thumb(app, c.id)).body, DET)).toBe(0);
    });

    // Review of #163: a fallback is never kept as the detection thumbnail.
    it('tries the detection again on a later request after a failed lookup', async () => {
      process.env.DETECTION_RETRY_MS = '0';
      try {
        const app = createApp();
        const c = await card(app, 'person');
        fake.events.set('cam1', [event(2, 'person', c.start + 6000)]);
        fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 6000, DET]]));
        fake.eventsStatus = 500;
        expect(Buffer.compare((await thumb(app, c.id)).body, STILL)).toBe(0);
        fake.eventsStatus = null;
        expect(Buffer.compare((await thumb(app, c.id)).body, DET)).toBe(0);
        expect(existsSync(join(cacheDir, `${fileSafe(k('cam1'))}_${c.id}.det.jpg`))).toBe(true);
      } finally {
        delete process.env.DETECTION_RETRY_MS;
      }
    });

    it('tries the detection again on a later request when its still was missing', async () => {
      process.env.DETECTION_RETRY_MS = '0';
      try {
        const app = createApp();
        const c = await card(app, 'person');
        fake.events.set('cam1', [event(2, 'person', c.start + 6000)]);
        fake.stills.set('cam1', new Map([[c.start + 2000, STILL]]));
        expect(Buffer.compare((await thumb(app, c.id)).body, STILL)).toBe(0);
        expect(existsSync(join(cacheDir, `${fileSafe(k('cam1'))}_${c.id}.det.jpg`))).toBe(false);
        fake.stills.get('cam1')!.set(c.start + 6000, DET);
        expect(Buffer.compare((await thumb(app, c.id)).body, DET)).toBe(0);
      } finally {
        delete process.env.DETECTION_RETRY_MS;
      }
    });

    it('asks again only after a pause: no retry storm while the lookup fails', async () => {
      const app = createApp();
      const c = await card(app, 'person');
      fake.eventsStatus = 500;
      fake.stills.set('cam1', new Map([[c.start + 2000, STILL]]));
      for (let i = 0; i < 3; i++) expect(Buffer.compare((await thumb(app, c.id)).body, STILL)).toBe(0);
      expect(eventLookups()).toBe(1);
    });

    // Klaus, 2026-10-04 (the real 05:16:43 card): the list names the card's
    // thumbnail (thumb: which event's still), and that version is the cache
    // key, so a Vision confirmation arriving later is a new thumbnail.
    describe('a version per card', () => {
      const thumbV = (app: ReturnType<typeof createApp>, id: string, v: string) => binary(request(app).get(`/api/cameras/cam1/clips/${id}/thumb.jpg?v=${v}`).set('Cookie', auth));
      async function listed(app: ReturnType<typeof createApp>, id: string) {
        const body = (await request(app).get(`/api/cameras/cam1/events?date=${today()}`).set('Cookie', auth)).body as { events: { id: string; thumb?: string; counts?: Record<string, number> }[] };
        return body.events.find((e) => e.id === id)!;
      }
      const none = (stillTs: number) => ({ provider: 'google-vision', status: 'ok', reason: null, stillTs, objects: [], summary: [] });
      const confirmed = (stillTs: number) => ({ ...none(stillTs), summary: [{ category: 'person', subtype: 'person', score: 0.8, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }] });
      const SECOND = Buffer.concat([JPEG, Buffer.from('still-of-the-second-person')]);

      it('two person events, the first not confirmed: the first one’s still, 36 s in; a later confirmation switches it', async () => {
        // The real card: 05:16:43, 103 s, person events at 05:17:19 and 05:17:28.
        await new Promise<void>((r) => cam.close(() => r()));
        const sim = await createSimCamera({ user: 'u', password: 'p', clips: [{ daysAgo: 0, start: '051643', end: '051826', triggers: ['person', 'motion'] }] });
        state = sim.state;
        cam = sim.app.listen(0);
        await new Promise((r) => cam.once('listening', r));
        setCameras([{ id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } }]);
        resetClients();
        resetRecordings();
        const app = createApp();
        const c = await card(app, 'person');
        expect(c.end - c.start).toBe(103_000);
        resetAiEventStore(); // the list above cached a day without the events
        fake.events.set('cam1', [event(927, 'motion', c.start + 33_000), event(928, 'person', c.start + 36_000, none(c.start + 37_000)), event(930, 'person', c.start + 45_000, none(c.start + 46_000))]);
        fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 36_000, DET], [c.start + 46_000, SECOND]]));
        const first = await listed(app, c.id);
        expect(first.thumb).toBe('d928');
        expect(first.counts).toEqual({ person: 2 });
        expect(Buffer.compare((await thumbV(app, c.id, first.thumb!)).body, DET)).toBe(0);
        expect(existsSync(join(cacheDir, `${fileSafe(k('cam1'))}_${c.id}.det-d928.jpg`))).toBe(true);
        // Vision confirms the second event; cam-proxy announces the analysis.
        fake.events.get('cam1')![2].analysis = confirmed(c.start + 46_000);
        proxyHub.emit('message', { cam: k('cam1'), type: 'analysis', data: {} });
        const later = await listed(app, c.id);
        expect(later.thumb).toBe('c930');
        expect(Buffer.compare((await thumbV(app, c.id, later.thumb!)).body, SECOND)).toBe(0);
        // The old version is still the old still (a page that hasn't reloaded yet).
        expect(Buffer.compare((await thumbV(app, c.id, 'd928')).body, DET)).toBe(0);
      });

      it('a motion card has no version and keeps the still 2 s in', async () => {
        const app = createApp();
        const c = await card(app, 'motion');
        resetAiEventStore();
        fake.events.set('cam1', [event(4, 'motion', c.start + 6000)]);
        fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 6000, DET]]));
        expect((await listed(app, c.id)).thumb).toBeUndefined();
        expect(Buffer.compare((await thumb(app, c.id)).body, STILL)).toBe(0);
      });

      it('a missed detection changes the version, so the page asks again; a found one goes back to it', async () => {
        process.env.DETECTION_RETRY_MS = '0';
        try {
          const app = createApp();
          const c = await card(app, 'person');
          resetAiEventStore();
          fake.events.set('cam1', [event(928, 'person', c.start + 6000)]);
          fake.stills.set('cam1', new Map([[c.start + 2000, STILL]])); // not yet at the detection
          expect((await listed(app, c.id)).thumb).toBe('d928');
          expect(Buffer.compare((await thumbV(app, c.id, 'd928')).body, STILL)).toBe(0);
          const retry = (await listed(app, c.id)).thumb!;
          expect(retry).toMatch(/^d928-r\d+$/);
          fake.stills.get('cam1')!.set(c.start + 6000, DET);
          expect(Buffer.compare((await thumbV(app, c.id, retry)).body, DET)).toBe(0);
          expect((await listed(app, c.id)).thumb).toBe('d928');
          expect(Buffer.compare((await thumbV(app, c.id, 'd928')).body, DET)).toBe(0);
        } finally {
          delete process.env.DETECTION_RETRY_MS;
        }
      });

      it('refuses a malformed version', async () => {
        const app = createApp();
        const c = await card(app, 'person');
        expect((await request(app).get(`/api/cameras/cam1/clips/${c.id}/thumb.jpg?v=../x`).set('Cookie', auth)).status).toBe(400);
      });
    });

    it('never looks up events for a motion-only card', async () => {
      const app = createApp();
      const c = await card(app, 'motion');
      fake.events.set('cam1', [event(4, 'person', c.start + 6000)]);
      fake.stills.set('cam1', new Map([[c.start + 2000, STILL], [c.start + 6000, DET]]));
      expect(Buffer.compare((await thumb(app, c.id)).body, STILL)).toBe(0);
      expect(eventLookups()).toBe(0);
    });
  });
});
