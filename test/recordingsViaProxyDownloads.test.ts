import { setTimeout as sleep } from 'timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'util';
import { logger } from '../server/logger';
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
import { createSimCamera, type SimCameraOptions, type SimState } from './camera/sim';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { recordingOf, seedRecordings } from './proxy/seedRecordings';
import { k } from './helpers/fleet';

// Spec 2026-10-02: the clip download of a camera with a cam-proxy. Sub: the
// proxy's recordings, its FTP copy (-proxy.mp4), the camera. Main (4K): the
// proxy's recordings, the camera, else full_quality_unavailable; never the
// FTP copy (Klaus: no silent quality downgrade).
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CLIP = Buffer.from('ftp copy bytes '.repeat(100));

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
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-viaproxy-dl-'));
  process.env.CACHE_DIR = cacheDir;
  process.env.RECORDINGS_PROBE_MS = '60000';
  fake = await startFakeProxy();
  await startCamera();
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
type Day = { events: { id: string; start: string }[] };
const events = async (id = 'cam1') => (await request(createApp()).get(`/api/cameras/${id}/events?date=${today()}`).set('Cookie', auth)).body as Day;
const download = (id: string, quality: 'sub' | 'main', camera = 'cam1') => request(createApp()).get(`/api/cameras/${camera}/clips/${id}/download?quality=${quality}`).set('Cookie', auth);
const fullQuality = async (id: string, camera = 'cam1') => (await request(createApp()).get(`/api/cameras/${camera}/clips/${id}/full-quality`).set('Cookie', auth)).body as { available: boolean };
const ftpCopy = (start: string) => fake.clips.push({ id: 8, cam: 'cam1', start: Date.parse(start) - 1000, end: Date.parse(start) + 30_000, stream: 'sub', events: [], body: CLIP });
const askedFtp = () => fake.requests.some((q) => q.path.endsWith('/clips') || /\/clips\/\d+\.mp4$/.test(q.path));
const fetchedFtp = () => fake.requests.some((q) => /\/clips\/\d+\.mp4$/.test(q.path));

async function seeded() {
  const list = await seedRecordings(fake, 'cam1', today());
  const day = await events();
  return { list, ev: day.events[0] };
}

describe('the clip download through cam-proxy’s recordings', () => {
  it('downloads sub and main from the proxy, named after the camera’s file', async () => {
    const { list, ev } = await seeded();
    const date = `${ev.id.slice(0, 4)}-${ev.id.slice(4, 6)}-${ev.id.slice(6, 8)}`;
    const t = ev.id.slice(9, 15);
    for (const q of ['sub', 'main'] as const) {
      const r = await binary(download(ev.id, q));
      expect(r.status).toBe(200);
      expect(r.headers['content-disposition']).toBe(`attachment; filename="cam1-${date}_${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}-${q}.mp4"`);
      expect(r.headers['content-length']).toBe(String(recordingOf(list, ev.id, q).body.length));
      expect(Buffer.compare(r.body, recordingOf(list, ev.id, q).body)).toBe(0);
    }
    expect(state.downloads).toBe(0);
    expect(getRecordings().downloadsState(k('cam1'))).toBe('proxy-recordings');
  });

  it('a sub download takes the FTP copy (-proxy.mp4) when the proxy’s recordings answer 502', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'timeout' } };
    const r = await binary(download(ev.id, 'sub'));
    expect(r.headers['content-disposition']).toMatch(/-proxy\.mp4"$/);
    expect(Buffer.compare(r.body, CLIP)).toBe(0);
    expect(state.downloads).toBe(0);
  });

  // Klaus, 2026-10-02: no silent quality downgrade. Review focus 2: the
  // camera needs the folder of a bare name from the proxy's list.
  it('a 4K download with the proxy failing takes the camera’s main file, never the FTP copy', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const searches = state.searches;
    const r = await binary(download(ev.id, 'main'));
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/-main\.mp4"$/);
    expect(Buffer.compare(r.body, CLIP)).not.toBe(0);
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(1);
    expect(state.searches).toBe(searches + 1);
  });

  it('a 4K download answers full_quality_unavailable when the proxy and the camera both fail, never the FTP copy', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ dropFirstDownloads: 1000 }); // the camera refuses every download
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const r = await download(ev.id, 'main');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'full_quality_unavailable' });
    expect(fetchedFtp()).toBe(false);
    // The standard quality is still there: the FTP copy.
    const sub = await binary(download(ev.id, 'sub'));
    expect(sub.status).toBe(200);
    expect(sub.headers['content-disposition']).toMatch(/-proxy\.mp4"$/);
  });

  it('says whether the full-resolution file can be served now, without a transfer', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ dropFirstDownloads: 1000 });
    const list = await seedRecordings(fake, 'cam1', today());
    const day = await events();
    const ev = day.events[0];
    // The proxy knows the main file (a HEAD, answered from its list).
    expect(await fullQuality(ev.id)).toEqual({ available: true });
    expect(fake.recordingFetches).toEqual([]);
    expect(fake.requests.some((q) => q.path.endsWith(recordingOf(list, ev.id, 'main').id))).toBe(true);
    // The proxy fails and the camera has no recent successful download (its
    // breaker never tried): not available (final review, minor 5).
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    expect(await fullQuality(ev.id)).toEqual({ available: false });
    // Three refused 4K downloads open the breaker: not available.
    for (const e of day.events.slice(0, 3)) expect((await download(e.id, 'main')).status).toBe(503);
    expect(await fullQuality(ev.id)).toEqual({ available: false });
    // A camera without a cam-proxy: its breaker, as before (closed here).
    const porch = await events('porch');
    expect(await fullQuality(porch.events[0].id, 'porch')).toEqual({ available: true });
    // Klaus' ruling: for such a camera the dialog never blocks 4K (no main
    // listed, or a breaker open): the answer is always true, as before.
    expect(await fullQuality('20200101-000000-000010', 'porch')).toEqual({ available: true });
  });

  it('answers unknown_clip for a recording gone from the SD card, with no fallback', async () => {
    const { list, ev } = await seeded();
    ftpCopy(ev.start);
    const mainId = recordingOf(list, ev.id, 'main').id;
    fake.recordings.set('cam1', list.filter((r) => r.id !== mainId));
    const r = await download(ev.id, 'main');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'unknown_clip' });
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  it('never tries another route for a viewer who left', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    const before = fake.requests.length;
    const ctl = new AbortController();
    ctl.abort();
    await expect(getRecordings().openDownload(k('cam1'), ev.id, 'sub', ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.requests.length).toBe(before);
    expect(state.downloads).toBe(0);
  });

  // Review focus 5: bytes were already sent, so the response ends short.
  it('ends the response short when the proxy drops mid-transfer, with no fallback', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingDropAfter = 100;
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cameras/cam1/clips/${ev.id}/download?quality=sub`, { headers: { Cookie: auth } });
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    expect(fetchedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  // Issue #132: a cut after the headers was silent.
  it('logs a proxy cut mid-download, with the clip but no token and no body', async () => {
    const { ev } = await seeded();
    const lines: unknown[][] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => void lines.push(a)) as never);
    fake.recordingDropAfter = 100;
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cameras/cam1/clips/${ev.id}/download?quality=sub`, { headers: { Cookie: auth } });
      await expect(res.arrayBuffer()).rejects.toThrow();
      await vi.waitFor(() => expect(lines.some((l) => l[1] === 'proxy_recording_cut')).toBe(true));
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      vi.restoreAllMocks();
    }
    const cut = lines.find((l) => l[1] === 'proxy_recording_cut')!;
    expect(cut[0]).toMatchObject({ cameraId: k('cam1'), clipId: ev.id });
    expect(inspect(lines, { depth: 8 })).not.toContain(FAKE_TOKEN);
  });

  it('does not log a viewer who left as a proxy cut', async () => {
    const { ev } = await seeded();
    const lines: unknown[][] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => void lines.push(a)) as never);
    fake.recordingStallAfter = 50;
    const ctl = new AbortController();
    try {
      const got = await getRecordings().openDownload(k('cam1'), ev.id, 'sub', ctl.signal);
      ctl.abort();
      got.stream.destroy();
      await sleep(100);
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.some((l) => l[1] === 'proxy_recording_cut')).toBe(false);
  });

  it('leaves a camera without a cam-proxy unchanged: the camera’s download, named -main', async () => {
    const day = await events('porch');
    const r = await download(day.events[0].id, 'main', 'porch');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="porch-.*-main\.mp4"$/);
    expect(state.downloads).toBe(1);
    expect(fake.requests).toEqual([]);
  });

  // Task 5 review, item 1: right after an event the main copy may not be
  // listed yet. A 4K request then never gets the sub file (no silent
  // downgrade), neither the SD sub file nor the FTP copy.
  it('answers full_quality_unavailable for a 4K request when the proxy lists no main file', async () => {
    const list = await seedRecordings(fake, 'cam1', today());
    fake.recordings.set('cam1', list.filter((r) => r.stream === 'sub'));
    const ev = (await events()).events[0];
    ftpCopy(ev.start);
    const r = await download(ev.id, 'main');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'full_quality_unavailable' });
    expect(fake.recordingFetches).toEqual([]);
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  it('answers full_quality_unavailable for a 4K request with no main file listed when the proxy’s recordings fail', async () => {
    const list = await seedRecordings(fake, 'cam1', today());
    fake.recordings.set('cam1', list.filter((r) => r.stream === 'sub'));
    const ev = (await events()).events[0];
    ftpCopy(ev.start);
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    const r = await download(ev.id, 'main');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'full_quality_unavailable' });
    expect(fake.recordingFetches).toEqual([]);
    expect(askedFtp()).toBe(false);
    expect(state.downloads).toBe(0);
  });

  // Task 5 review, item 2: a read-only question leaves the downloads note alone.
  it('does not change the downloads state when the full-quality question fails at the proxy', async () => {
    const { ev } = await seeded();
    expect(getRecordings().downloadsState(k('cam1'))).toBe('proxy-recordings');
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    expect(await fullQuality(ev.id)).toEqual({ available: false });
    expect(getRecordings().downloadsState(k('cam1'))).toBe('proxy-recordings');
  });

  // Final review, minor 5: with the proxy failing, 4K is offered only when the
  // camera itself served a download recently; a plain 404 HEAD stays optimistic.
  it('offers 4K with the proxy failing only after a recent camera download; a 404 HEAD stays optimistic', async () => {
    const { list, ev } = await seeded();
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'timeout' } };
    expect(await fullQuality(ev.id)).toEqual({ available: false });
    expect((await binary(download(ev.id, 'main'))).status).toBe(200); // the camera's own file
    expect(state.downloads).toBe(1);
    expect(await fullQuality(ev.id)).toEqual({ available: true });
    fake.recordingsOverride = null;
    resetRecordings();
    const mainId = recordingOf(list, ev.id, 'main').id;
    await events(); // the list still has the main file
    fake.recordings.set('cam1', list.filter((r) => r.id !== mainId)); // HEAD now answers 404
    expect(await fullQuality(ev.id)).toEqual({ available: true });
  });

  // Task 5 review, item 3: an unreachable proxy, for 4K: the camera's main
  // file, else full_quality_unavailable.
  it('a 4K download with the proxy unreachable takes the camera’s main file, else full_quality_unavailable', async () => {
    const deadProxy = () => {
      const host = `127.0.0.1:${(cam.address() as AddressInfo).port}`;
      setCameras([{ id: 'cam1', name: 'Den', host, protocol: 'http', user: 'u', password: 'p', proxy: { url: 'http://127.0.0.1:9', token: FAKE_TOKEN } }]);
      resetProxyClients();
    };
    let { ev } = await seeded();
    ftpCopy(ev.start);
    deadProxy();
    const r = await binary(download(ev.id, 'main'));
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/-main\.mp4"$/);
    expect(state.downloads).toBe(1);

    await new Promise<void>((done) => cam.close(() => done()));
    await startCamera({ dropFirstDownloads: 1000 });
    ({ ev } = await seeded());
    deadProxy();
    const refused = await download(ev.id, 'main');
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: 'full_quality_unavailable' });
  });

  // Coordinator ruling: full_quality_unavailable is for proxied cameras only;
  // without a cam-proxy a refused 4K download answers what it always did.
  it('leaves a refused 4K download of a camera without a cam-proxy unchanged', async () => {
    await new Promise<void>((r) => cam.close(() => r()));
    await startCamera({ dropFirstDownloads: 1000 });
    const day = await events('porch');
    for (const e of day.events.slice(0, 3)) {
      const r = await download(e.id, 'main', 'porch');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: 'camera_offline' });
    }
    // The breaker is open now: the old answer.
    const r = await download(day.events[0].id, 'main', 'porch');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'recordings_unavailable' });
    expect(fake.requests).toEqual([]);
  });
});

// The Archive button's plain save (cam-proxy's archive contract §2): the
// file the download would serve, by its bare name; the FTP copy for SD while
// the proxy's recordings fail; no silent 4K downgrade.
describe('what the Archive stores for a plain save', () => {
  it('names the SD card’s file of the requested stream, and the proxy archives it', async () => {
    const { list, ev } = await seeded();
    expect(await getRecordings().archiveSource(k('cam1'), ev.id, 'sub')).toEqual({ type: 'recording', id: recordingOf(list, ev.id, 'sub').id });
    expect(await getRecordings().archiveSource(k('cam1'), ev.id, 'main')).toEqual({ type: 'recording', id: recordingOf(list, ev.id, 'main').id });
    const r = await request(createApp()).post('/api/cameras/cam1/archive').set('Cookie', auth).send({ source: { type: 'event', eventId: ev.id, quality: 'main' }, labels: ['4K'] });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ original: true, quality: '4k', labels: ['4K'], bytes: recordingOf(list, ev.id, 'main').body.length, source: { type: 'recording', stream: 'main' } });
  });

  it('takes the FTP copy for SD while the proxy’s recordings fail, as the download does', async () => {
    const { ev } = await seeded();
    ftpCopy(ev.start);
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'timeout' } };
    await binary(download(ev.id, 'sub')); // the failure is noted
    expect(await getRecordings().archiveSource(k('cam1'), ev.id, 'sub')).toEqual({ type: 'clip', clipId: 8 });
  });
});
