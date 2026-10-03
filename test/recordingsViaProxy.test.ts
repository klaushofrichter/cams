import { setTimeout as sleep } from 'timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { loadProxyState, setProxyEnabled } from '../server/proxyState';
import { getClient, resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { dayBounds, getRecordings, resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, type SimState } from './camera/sim';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { recordingOf, seedRecordings } from './proxy/seedRecordings';

// Spec 2026-10-02 (recordings via cam-proxy): for a camera with a cam-proxy
// the day's list and the month's days come from the proxy's recordings API,
// so every camera Search goes through the proxy's one searcher; the camera's
// own Search only when the proxy can't answer.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const chicago = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const today = () => chicago(Date.now());
const yesterday = () => chicago(Date.now() - 86_400_000);

let cam: Server;
let state: SimState;
let fake: FakeProxy;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-viaproxy-'));
  process.env.CACHE_DIR = cacheDir;
  process.env.PROXY_STATE_FILE = join(cacheDir, 'proxy-state.json');
  loadProxyState();
  const sim = await createSimCamera({ user: 'u', password: 'p' });
  state = sim.state;
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  const host = `127.0.0.1:${(cam.address() as AddressInfo).port}`;
  fake = await startFakeProxy();
  setCameras([
    { id: 'cam1', name: 'Den', host, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } },
    { id: 'porch', name: 'Porch', host, protocol: 'http', user: 'u', password: 'p' },
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
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
  rmSync(cacheDir, { recursive: true, force: true });
});

type Day = { events: { id: string; start: string; end: string; triggers: string[]; sizeSub: number | null; sizeMain: number | null }[]; downloads: string };
const events = async (id = 'cam1', date = today()) => (await request(createApp()).get(`/api/cameras/${id}/events?date=${date}`).set('Cookie', auth)).body as Day;
const daysOf = async (id: string, month: string) => (await request(createApp()).get(`/api/cameras/${id}/days?month=${month}`).set('Cookie', auth)).body as { days: string[] };
const recordingAsks = () => fake.requests.filter((r) => r.path.startsWith('/api/cameras/cam1/recordings'));
const shape = (d: Day) => d.events.map((e) => [e.id, e.start, e.end, e.triggers]);

describe('the day’s list and the month’s days through cam-proxy', () => {
  it('lists the day from the proxy, sub then main, paired like the camera’s Search, without a camera Search', async () => {
    const date = today();
    const list = await seedRecordings(fake, 'cam1', date);
    const searches = state.searches;
    const viaProxy = await events();
    expect(state.searches).toBe(searches);
    expect(viaProxy.downloads).toBe('proxy-recordings');
    const asks = recordingAsks();
    expect(asks.map((r) => r.query.stream)).toEqual(['sub', 'main']);
    expect(asks.map((r) => r.query)).toEqual([{ date, stream: 'sub' }, { date, stream: 'main' }]);
    expect(viaProxy.events.length).toBeGreaterThan(0);
    for (const ev of viaProxy.events) {
      expect(ev.sizeSub).toBe(recordingOf(list, ev.id, 'sub').body.length);
      expect(ev.sizeMain).toBe(recordingOf(list, ev.id, 'main').body.length);
    }
    // The same events as the camera's own Search gives.
    resetRecordings();
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    expect(shape(viaProxy)).toEqual(shape(await events()));
  });

  // Review focus 1: an older cam-proxy answers a plain 404.
  it.each([
    ['502', () => void (fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } })],
    ['503', () => void (fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } })],
    ['400', () => void (fake.recordingsOverride = { status: 400, body: { error: 'invalid' } })],
    ['an older cam-proxy (plain 404)', () => void (fake.recordingsOverride = { status: 404, body: { error: 'not_found' } })],
    ['a refused token', () => void (fake.token = 'another-token-'.padEnd(48, 'x'))],
    ['an unreachable proxy', () => void (fake.offline = true)],
  ])('falls back to the camera’s Search on %s', async (_name, breakIt) => {
    await seedRecordings(fake, 'cam1', today());
    const searches = state.searches;
    breakIt();
    const day = await events();
    expect(day.events.length).toBeGreaterThan(0);
    expect(state.searches).toBe(searches + 2);
    expect(day.downloads).toBe('proxy');
  }, 15_000);

  // Final review, minor 2: a fallback Search can collide with the proxy's own
  // Search and come back empty, so such an empty day isn't kept for long.
  it('keeps an empty past day from a fallback Search only briefly; a camera without a proxy keeps it', async () => {
    const past = '2020-01-01';
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const searches = state.searches;
    expect((await events('cam1', past)).events).toEqual([]);
    expect((await events('porch', past)).events).toEqual([]);
    expect(state.searches).toBe(searches + 4);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    try {
      await events('cam1', past);
      await events('porch', past);
      expect(state.searches).toBe(searches + 6); // cam1 searched again, porch from the cache
    } finally {
      clock.mockRestore();
    }
  });

  it('says proxy-recordings again once the proxy answers again', async () => {
    await seedRecordings(fake, 'cam1', today());
    await seedRecordings(fake, 'cam1', yesterday());
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    expect((await events()).downloads).toBe('proxy');
    fake.recordingsOverride = null;
    expect((await events('cam1', yesterday())).downloads).toBe('proxy-recordings');
  });

  it('reads the month’s days from the proxy; the camera’s month Search only when the proxy fails', async () => {
    const date = today();
    const month = date.slice(0, 7);
    await seedRecordings(fake, 'cam1', date);
    const searches = state.searches;
    expect((await daysOf('cam1', month)).days).toEqual([date]);
    expect(state.searches).toBe(searches);
    expect(recordingAsks().at(-1)).toMatchObject({ path: '/api/cameras/cam1/recordings/days', query: { month } });
    resetRecordings();
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'search_failed' } };
    expect((await daysOf('cam1', month)).days).toContain(date);
    expect(state.searches).toBe(searches + 1);
  });

  it('asks an older proxy again with from and to when it answers 400 to date, still without a camera Search', async () => {
    await seedRecordings(fake, 'cam1', today());
    const searches = state.searches;
    fake.legacyRecordings = true;
    const day = await events();
    expect(state.searches).toBe(searches);
    expect(day.downloads).toBe('proxy-recordings');
    expect(day.events.length).toBeGreaterThan(0);
    const asks = recordingAsks();
    expect(asks.map((r) => Object.keys(r.query).sort().join())).toEqual(['date,stream', 'from,stream,to', 'from,stream,to']); // the memo spares main its date= try
    expect(asks.filter((r) => r.query.from !== undefined).map((r) => r.query.stream)).toEqual(['sub', 'main']);
  });

  it('retries a busy proxy once after its Retry-After, without a camera Search', async () => {
    await seedRecordings(fake, 'cam1', today());
    const searches = state.searches;
    fake.recordingsBusy = 1;
    const day = await events();
    expect(state.searches).toBe(searches);
    expect(day.downloads).toBe('proxy-recordings');
    expect(day.events.length).toBeGreaterThan(0);
  }, 15_000);

  it('falls back to the camera’s Search when the proxy is still busy after the retry', async () => {
    await seedRecordings(fake, 'cam1', today());
    const searches = state.searches;
    fake.recordingsBusy = 10;
    const day = await events();
    expect(day.events.length).toBeGreaterThan(0);
    expect(state.searches).toBe(searches + 2);
    expect(day.downloads).toBe('proxy');
  }, 15_000);

  it('stops the day list when the viewer leaves during a busy wait, without a camera Search', async () => {
    await seedRecordings(fake, 'cam1', today());
    fake.recordingsBusy = 5;
    const searches = state.searches;
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const ctl = new AbortController();
      const gone = fetch(`http://127.0.0.1:${port}/api/cameras/cam1/events?date=${today()}`, { headers: { Cookie: auth }, signal: ctl.signal }).catch(() => 'aborted');
      await vi.waitFor(() => expect(recordingAsks().length).toBe(1));
      ctl.abort();
      expect(await gone).toBe('aborted');
      await sleep(1600); // past the proxy's Retry-After of 1 s
      expect(recordingAsks().length).toBe(1);
      expect(state.searches).toBe(searches);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it('never joins an abandoned day list: a viewer arriving right after the last one left gets a fresh list', async () => {
    await seedRecordings(fake, 'cam1', today());
    fake.recordingsBusy = 1;
    const rec = getRecordings();
    const ctl = new AbortController();
    const first = rec.events('cam1', today(), ctl.signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(recordingAsks().length).toBe(1));
    ctl.abort(new Error('left'));
    const second = rec.events('cam1', today(), new AbortController().signal); // before the abandoned list has settled
    expect(await first).toMatchObject({ message: 'left' });
    expect((await second).length).toBeGreaterThan(0);
  }, 15_000);

  it('raises no unhandled rejection when the creator of a day list is already gone', async () => {
    await seedRecordings(fake, 'cam1', today());
    const seen = vi.fn();
    process.on('unhandledRejection', seen);
    try {
      await expect(getRecordings().events('cam1', today(), AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
      await sleep(200);
      expect(seen).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', seen);
    }
  });

  // Only for an older proxy without date=.
  it('keeps dayBounds, the window for an older proxy, wide enough for either offset', () => {
    expect(dayBounds('2026-11-01', { stdOffsetMinutes: -360, dstOffsetMinutes: 60 })).toEqual({ from: Date.parse('2026-11-01T05:00:00Z'), to: Date.parse('2026-11-02T06:00:00Z') - 1 });
    // Berlin, spring forward: the day is 23 hours long.
    expect(dayBounds('2026-03-29', { stdOffsetMinutes: 60, dstOffsetMinutes: 60 })).toEqual({ from: Date.parse('2026-03-28T22:00:00Z'), to: Date.parse('2026-03-30T00:00:00Z') - 3_600_000 - 1 });
    expect(dayBounds('2026-10-02', { stdOffsetMinutes: 0, dstOffsetMinutes: 0 })).toEqual({ from: Date.parse('2026-10-02T00:00:00Z'), to: Date.parse('2026-10-03T00:00:00Z') - 1 });
  });

  it('leaves a camera without a cam-proxy unchanged: the camera’s Search, no proxy request, downloads ok', async () => {
    const searches = state.searches;
    const day = await events('porch');
    expect(day.events.length).toBeGreaterThan(0);
    expect(state.searches).toBe(searches + 2);
    expect(day.downloads).toBe('ok');
    await daysOf('porch', today().slice(0, 7));
    expect(state.searches).toBe(searches + 3);
    expect(fake.requests.some((r) => r.path.includes('/recordings'))).toBe(false);
  });

  it('asks the camera, not the proxy, while the cam-proxy is switched off', async () => {
    await setProxyEnabled('cam1', false);
    const searches = state.searches;
    const day = await events();
    expect(state.searches).toBe(searches + 2);
    expect(day.downloads).toBe('ok');
    expect(fake.requests.some((r) => r.path.includes('/recordings'))).toBe(false);
  });
});
