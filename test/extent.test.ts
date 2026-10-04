import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { resetRecordings } from '../server/recordings/service';
import { resetExtentCache } from '../server/recordings/extent';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera } from './camera/sim';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

// The History strip's left edge (Klaus, 2026-09-28): the oldest content a
// camera has, on its SD card or at its cam-proxy.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const DAY = 86_400_000;
let cam: Server;
let fake: FakeProxy;

async function setup(withProxy: boolean) {
  const sim = await createSimCamera({ user: 'u', password: 'p', clips: [
    { daysAgo: 5, start: '060000', end: '060030', triggers: ['motion'] }, // within the sim's 7 days
    { daysAgo: 0, start: '010000', end: '010030', triggers: ['person'] },
  ] });
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  fake = await startFakeProxy();
  const host = `127.0.0.1:${(cam.address() as AddressInfo).port}`;
  setCameras([{ id: 'cam1', name: 'Den', host, protocol: 'http', user: 'u', password: 'p', ...(withProxy ? { proxy: { url: fake.url, token: FAKE_TOKEN } } : {}) }]);
  resetClients();
  resetProxyClients();
  resetRecordings();
  resetExtentCache();
}
afterEach(async () => {
  cam.close();
  await fake.stop();
  setCameras([]);
});

const get = (path: string) => request(createApp()).get(path).set('Cookie', auth);
// The camera's oldest recording, as its own events list gives it.
async function cameraOldest(): Promise<number> {
  // Calendar months, not 31-day steps: on the 1st (UTC) the camera can still be
  // in the previous month, and Oct 1 − 31 days skips September.
  const now = new Date();
  for (const back of [2, 1, 0]) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
    for (const day of ((await get(`/api/cameras/cam1/days?month=${month}`)).body.days as string[]).sort()) {
      const ev = (await get(`/api/cameras/cam1/events?date=${day}`)).body.events as { start: string }[];
      if (ev.length) return Math.min(...ev.map((e) => Date.parse(e.start)));
    }
  }
  throw new Error('no recordings');
}

describe('GET /api/cameras/:id/extent', () => {
  it('is the camera’s oldest recording when there is no proxy', async () => {
    await setup(false);
    const res = await get('/api/cameras/cam1/extent');
    expect(res.status).toBe(200);
    expect(res.body.oldest).toBe(await cameraOldest());
    expect(res.body.stills).toBeNull(); // no proxy, no stills
  });

  it('is the proxy’s oldest content when that is older', async () => {
    await setup(true);
    const old = Date.now() - 50 * DAY;
    fake.stills.set('cam1', new Map([[old, JPEG]]));
    expect((await get('/api/cameras/cam1/extent')).body.oldest).toBe(old);
  });

  // Issue #159: the Timeline's one-second steps stop at the oldest still.
  it('names the proxy’s oldest still apart', async () => {
    await setup(true);
    const old = Date.now() - 2 * DAY;
    fake.stills.set('cam1', new Map([[old + 5000, JPEG], [old, JPEG]]));
    expect((await get('/api/cameras/cam1/extent')).body.stills).toBe(old);
  });

  it('is the camera’s when the proxy fails', async () => {
    await setup(true);
    await fake.stop();
    expect((await get('/api/cameras/cam1/extent')).body.oldest).toBe(await cameraOldest());
  });

  it('refuses unknown cameras', async () => {
    await setup(false);
    expect((await get('/api/cameras/nope/extent')).status).toBe(404);
  });
});
