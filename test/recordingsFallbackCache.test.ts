import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { loadProxyState, setProxyEnabled } from '../server/proxyState';
import { resetClients } from '../server/reolink/clients';
import { resetProxyClients } from '../server/proxy/client';
import { resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, type SimState } from './camera/sim';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { seedRecordings } from './proxy/seedRecordings';
import { logger } from '../server/logger';

// Issue #132 (items 3-5): fallback results are kept briefly, and a hanging
// proxy is asked once per spell. Setup as recordingsViaProxy.test.ts.
// (Spec 2026-10-02: for a camera with a cam-proxy
// the day's list and the month's days come from the proxy's recordings API,
// so every camera Search goes through the proxy's one searcher; the camera's
// own Search only when the proxy can't answer.)
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const chicago = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const today = () => chicago(Date.now());

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

const CACHE_SHORT_MS = 60_000; // past the short TTL (30 s), far inside the long ones (5 and 10 min)
const warns = (spy: MockInstance<typeof logger.warn>) => spy.mock.calls.filter((c) => (c as unknown[])[1] === 'proxy_recordings_failed').length;
const later = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);

afterEach(() => vi.restoreAllMocks());

describe('month lists from a fallback (item 3)', () => {
  it('keeps an empty month from a fallback Search only briefly; a camera without a proxy keeps it', async () => {
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const searches = state.searches;
    expect((await daysOf('cam1', '2020-01')).days).toEqual([]);
    expect((await daysOf('porch', '2020-01')).days).toEqual([]);
    expect(state.searches).toBe(searches + 2);
    later(CACHE_SHORT_MS);
    await daysOf('cam1', '2020-01');
    await daysOf('porch', '2020-01');
    expect(state.searches).toBe(searches + 3); // cam1 searched again, porch from the cache
  });

  it('asks the proxy again after the short time once it has recovered', async () => {
    const date = today();
    await seedRecordings(fake, 'cam1', date);
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const month = date.slice(0, 7);
    expect((await daysOf('cam1', month)).days).toContain(date);
    fake.recordingsOverride = null;
    later(CACHE_SHORT_MS);
    const before = recordingAsks().length;
    expect((await daysOf('cam1', month)).days).toEqual([date]);
    expect(recordingAsks().length).toBe(before + 1);
  });

  it('keeps a month the proxy listed for the full time', async () => {
    const date = today();
    await seedRecordings(fake, 'cam1', date);
    await daysOf('cam1', date.slice(0, 7));
    const before = recordingAsks().length;
    later(CACHE_SHORT_MS);
    await daysOf('cam1', date.slice(0, 7));
    expect(recordingAsks().length).toBe(before);
  });
});

describe('a day cached after a fallback (item 4)', () => {
  it('is asked of the proxy again after the short time, even a past day with events', async () => {
    const date = today();
    await seedRecordings(fake, 'cam1', date);
    const base = Date.now();
    const clock = later(3 * 86_400_000); // the day is past, so its normal time is 10 min (3 days: inside the session)
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const first = await events('cam1', date);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.downloads).toBe('proxy');
    fake.recordingsOverride = null;
    clock.mockReturnValue(base + 3 * 86_400_000 + CACHE_SHORT_MS);
    expect((await events('cam1', date)).downloads).toBe('proxy-recordings');
  });

  it('keeps a day the proxy listed for the full time', async () => {
    const date = today();
    await seedRecordings(fake, 'cam1', date);
    const base = Date.now();
    const clock = later(3 * 86_400_000);
    await events('cam1', date);
    const before = recordingAsks().length;
    clock.mockReturnValue(base + 3 * 86_400_000 + CACHE_SHORT_MS);
    await events('cam1', date);
    expect(recordingAsks().length).toBe(before);
  });
});

describe('a hanging proxy (item 5)', () => {
  it('is asked once for a day view: the failure is shared with the next day and month lists', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    fake.offline = true; // every request is cut: the same path as a timeout
    expect((await events('cam1', today())).events.length).toBeGreaterThan(0);
    expect(warns(warn)).toBe(1); // sub failed, main was not tried
    await events('cam1', '2020-01-01');
    await daysOf('cam1', today().slice(0, 7));
    expect(warns(warn)).toBe(1); // no new proxy attempt for them
  });

  it('asks the proxy again once the spell is over', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    fake.offline = true;
    await events('cam1', today());
    later(20_000);
    await events('cam1', '2020-01-01');
    expect(warns(warn)).toBe(2);
  });

  it('does not stop asking the proxy after an answer that is only an error status', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    await events('cam1', today());
    await events('cam1', '2020-01-01');
    expect(warns(warn)).toBe(2);
  });
});
