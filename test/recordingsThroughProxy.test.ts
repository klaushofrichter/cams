// Recordings of a through-proxy camera (spec §4.8, §6.1): lists, clips and
// downloads from the proxy only, no camera Search or Download fallback;
// times from the proxy's status.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp } from '../server/app';
import { ReolinkClient } from '../server/reolink/client';
import { clipTimes, parseClipName } from '../server/recordings/clipNames';
import { getRecordings, resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { fakeStatus, type FakeRecording } from './proxy/fakeProxy';
import { startThroughProxy, type ThroughProxy } from './helpers/throughProxy';
import { k } from './helpers/fleet';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const chicago = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
let t: ThroughProxy;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;
let base: { searches: number; downloads: number; logins: number };

// The SD recordings the fake lists: what cam-sim holds for `date`, read with
// a client of its own before any counting starts.
async function seed(date: string): Promise<FakeRecording[]> {
  const c = new ReolinkClient({ id: 'seed', name: 'seed', host: t.simHost, protocol: 'http', user: 'u', password: 'p' });
  const time = await c.timeInfo();
  const list: FakeRecording[] = [];
  for (const stream of ['sub', 'main'] as const) {
    for (const f of await c.searchDay(date, stream)) {
      const p = parseClipName(f.name);
      if (!p) continue;
      const tt = clipTimes(p, time);
      const id = f.name.slice(f.name.lastIndexOf('/') + 1);
      list.push({ id, start: Date.parse(tt.start), end: Date.parse(tt.end), stream, body: Buffer.from(`sd ${stream} ${id} `.repeat(10)) });
    }
  }
  t.fake.recordings.set('cam1', list);
  return list;
}

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-through-rec-'));
  process.env.CACHE_DIR = cacheDir;
  t = await startThroughProxy();
  resetRecordings();
  await seed(chicago(Date.now()));
  base = { searches: t.sim.searches, downloads: t.sim.downloads, logins: t.sim.loginAttempts };
});
afterEach(async () => {
  expect(t.sim.searches).toBe(base.searches);
  expect(t.sim.downloads).toBe(base.downloads);
  expect(t.sim.loginAttempts).toBe(base.logins);
  await t.close();
  process.env.CACHE_DIR = workerCacheDir;
  rmSync(cacheDir, { recursive: true, force: true });
});

const get = (path: string) => request(createApp()).get(path).set('Cookie', auth);
const today = () => chicago(Date.now());

describe('recordings through the proxy only', () => {
  it('lists the day and month, plays a clip and downloads one from the proxy', async () => {
    const day = await get(`/api/cameras/den/events?date=${today()}`).expect(200);
    expect(day.body.events.length).toBeGreaterThan(0);
    const month = await get(`/api/cameras/den/days?month=${today().slice(0, 7)}`).expect(200);
    expect(month.body.days).toContain(today());
    const id = day.body.events[0].id as string;
    const video = await get(`/api/cameras/den/clips/${id}/video`).expect(200);
    expect(Buffer.from(video.body as Buffer).toString()).toContain('sd sub');
    const dl = await get(`/api/cameras/den/clips/${id}/download?quality=main`).expect(200);
    expect(Buffer.from(dl.body as Buffer).toString()).toContain('sd main');
  });

  it('fails with recordings_unavailable when the proxy can\'t answer, without a camera fallback', async () => {
    const day = await get(`/api/cameras/den/events?date=${today()}`).expect(200);
    const id = day.body.events[0].id as string;
    resetRecordings();
    t.fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } };
    const list = await get(`/api/cameras/den/events?date=${today()}`);
    expect(list.status).toBeGreaterThanOrEqual(500);
    expect(list.body).toMatchObject({ error: 'recordings_unavailable' });
    await get(`/api/cameras/den/days?month=${today().slice(0, 7)}`).expect((r) => expect(r.body).toMatchObject({ error: 'recordings_unavailable' }));
    // A day listed before: the clip and download go to the proxy only.
    t.fake.recordingsOverride = null;
    await get(`/api/cameras/den/events?date=${today()}`).expect(200);
    t.fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } };
    const v = await get(`/api/cameras/den/clips/${id}/video`);
    expect(v.status).toBeGreaterThanOrEqual(500);
    const d = await get(`/api/cameras/den/clips/${id}/download?quality=sub`);
    expect(d.status).toBeGreaterThanOrEqual(500);
  });

  it('takes the camera\'s time from the proxy (invalidateAround, a composition\'s name)', async () => {
    t.fake.cameraStatus.set('cam1', fakeStatus({ time: { clockOffsetMs: 0, stdOffsetMinutes: 540, dstOffsetMinutes: 0, dstRule: null } }));
    expect(await getRecordings().cameraTime(k('den'))).toEqual({ stdOffsetMinutes: 540, dstOffsetMinutes: 0 });
    await getRecordings().invalidateAround(k('den'), Date.now());
    const AT = Math.floor(Date.now() / 1000) * 1000 - 60_000;
    t.fake.stills.set('cam1', new Map(Array.from({ length: 61 }, (_, i) => [AT - 30_000 + i * 1000, Buffer.from([0xff, 0xd8, 0xff, 0xd9])])));
    const r = await request(createApp()).post('/api/cameras/den/compositions').set('Cookie', auth).send({ at: AT, preS: 10, postS: 10, size: 'sd', badge: true });
    expect(r.status).toBe(201);
    const stamp = new Date(AT + 540 * 60_000).toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
    expect(r.body.name).toBe(`den-${stamp}-around.mp4`);
  });
});
