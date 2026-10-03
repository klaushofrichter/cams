import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'util';
import { setCameras } from '../server/cameraRegistry';
import { logger } from '../server/logger';
import { ProxyError, resetProxyClients } from '../server/proxy/client';
import { RecordingError } from '../server/recordings/errors';
import { fallsBack, listProxyDay, listProxyDays, listProxyRecordings, logProxyFailure, openProxyRecording, resetLegacyProxies } from '../server/recordings/proxyRecordings';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

// The client for cam-proxy's recordings API (spec 2026-10-02).
const SUB = 'RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4';
const MAIN = 'RecM0A_DST20261001_211129_211209_0_5514C080000000_66A92E.mp4';
const GONE = 'RecS0A_DST20261001_000000_000010_0_5514C080000000_1.mp4';
const T0 = 1_790_000_000_000;

let fake: FakeProxy;
beforeEach(async () => {
  fake = await startFakeProxy();
  // cams calls the camera "den"; its proxy calls it "cam1".
  setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } }]);
  resetProxyClients();
  fake.recordings.set('cam1', [
    { id: SUB, start: T0, end: T0 + 38_000, stream: 'sub', body: Buffer.from('sub-bytes') },
    { id: MAIN, start: T0, end: T0 + 40_000, stream: 'main', body: Buffer.from('main-bytes'), kinds: ['person'], clipId: 1312 },
  ]);
});
afterEach(async () => {
  resetLegacyProxies();
  await fake.stop();
  setCameras([]);
  resetProxyClients();
  vi.restoreAllMocks();
});

const text = async (s: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString();
};
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );

describe('proxy recordings client', () => {
  it('lists one stream under the proxy’s camera id', async () => {
    expect(await listProxyRecordings('den', T0 - 1, T0 + 1, 'main')).toEqual([{ id: MAIN, start: T0, end: T0 + 40_000, stream: 'main', size: 10, kinds: ['person'], clipId: 1312 }]);
    expect(fake.requests.at(-1)).toMatchObject({ path: '/api/cameras/cam1/recordings', query: { from: String(T0 - 1), to: String(T0 + 1), stream: 'main' } });
  });

  // Review focus 4: an id is later used in a URL; only well-formed names pass.
  it('drops entries that are not a well-formed recording, and refuses a list that is not a list', async () => {
    fake.recordings.get('cam1')!.push({ id: '../../etc/passwd.mp4', start: T0, end: T0, stream: 'sub', body: Buffer.from('x') });
    expect((await listProxyRecordings('den', T0 - 1, T0 + 1, 'sub')).map((r) => r.id)).toEqual([SUB]);
    fake.recordingsOverride = { status: 200, body: { not: 'a list' } };
    const err = await caught(listProxyRecordings('den', T0 - 1, T0 + 1, 'sub'));
    expect(err).toMatchObject({ name: 'ProxyError', code: 'proxy_error' });
    expect(fallsBack(err)).toBe(true);
  });

  it('reads the month’s days, dropping any that are not a day of it', async () => {
    expect(await listProxyDays('den', '2026-10')).toEqual(['2026-10-01']);
    fake.recordingsOverride = { status: 200, body: { month: '2026-09', days: [0, 3, 3, 30, 31, 2.5, '4'] } };
    expect(await listProxyDays('den', '2026-09')).toEqual(['2026-09-03', '2026-09-30']);
    fake.recordingsOverride = { status: 200, body: { month: '2026-09' } };
    expect(await caught(listProxyDays('den', '2026-09'))).toMatchObject({ name: 'ProxyError' });
  });

  it('opens a file with its size', async () => {
    const got = await openProxyRecording('den', SUB);
    expect(got.size).toBe(9);
    expect(await text(got.stream)).toBe('sub-bytes');
    expect(fake.requests.at(-1)?.path).toBe(`/api/cameras/cam1/recordings/${SUB}`);
  });

  it('calls a recording gone from the SD card unknown_clip, which never falls back', async () => {
    const err = await caught(openProxyRecording('den', GONE));
    expect(err).toBeInstanceOf(RecordingError);
    expect((err as RecordingError).code).toBe('unknown_clip');
    expect(fallsBack(err)).toBe(false);
  });

  // Review focus 1: an older cam-proxy has no recordings API (a plain 404).
  it.each([
    ['502', { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } }],
    ['503', { status: 503, body: { error: 'camera_offline' } }],
    ['400 (a bug in cams)', { status: 400, body: { error: 'invalid' } }],
    ['an older cam-proxy without the API (plain 404)', { status: 404, body: { error: 'not_found' } }],
  ])('falls back on %s, for the list, the days and a file', async (_name, answer) => {
    fake.recordingsOverride = answer;
    for (const p of [listProxyRecordings('den', 0, 1, 'sub'), listProxyDays('den', '2026-10'), openProxyRecording('den', SUB)]) {
      const err = await caught(p);
      expect(err).toMatchObject({ name: 'ProxyError', status: answer.status });
      expect(fallsBack(err)).toBe(true);
    }
  });

  it.each(['refused', 'auth', 'timeout', 'protocol', 'offline', 'search_failed'])('falls back on 502 recordings_unavailable, reason %s', async (reason) => {
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason } };
    const err = await caught(openProxyRecording('den', SUB));
    expect(err).toMatchObject({ name: 'ProxyError', status: 502, upstream: 'recordings_unavailable' });
    expect(fallsBack(err)).toBe(true);
  });

  // The proxy fetches one file at a time per camera and can hold a request's
  // headers until a queued download finishes.
  it('waits for the headers of a file up to the header timeout, and no longer', async () => {
    fake.recordingDelayMs = 300;
    const got = await openProxyRecording('den', SUB, undefined, { headerTimeoutMs: 1500 });
    expect(await text(got.stream)).toBe('sub-bytes');
    const err = await caught(openProxyRecording('den', SUB, undefined, { headerTimeoutMs: 100 }));
    expect(err).toMatchObject({ name: 'ProxyError', code: 'proxy_unreachable' });
    expect(fallsBack(err)).toBe(true);
  });

  it('falls back when the proxy is unreachable or refuses the token', async () => {
    fake.offline = true;
    let err = await caught(listProxyRecordings('den', 0, 1, 'sub'));
    expect(err).toMatchObject({ name: 'ProxyError', code: 'proxy_unreachable' });
    expect(fallsBack(err)).toBe(true);
    fake.offline = false;
    fake.token = 'another-token-'.padEnd(48, 'x');
    err = await caught(openProxyRecording('den', SUB));
    expect(err).toMatchObject({ name: 'ProxyError', code: 'proxy_unauthorized' });
    expect(fallsBack(err)).toBe(true);
  });

  it('never falls back once the viewer left', async () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(fallsBack(new Error('aborted'), ctl.signal)).toBe(false);
  });

  it('starts nothing with a signal that is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const err = await caught(openProxyRecording('den', SUB, ctl.signal));
    expect(err).not.toBeInstanceOf(ProxyError);
    expect((err as Error).name).toBe('AbortError');
    expect(fallsBack(err, ctl.signal)).toBe(false);
    expect(fake.recordingFetches).toEqual([]);
  });

  it('throws the abort, not a ProxyError, when the viewer leaves while the headers wait', async () => {
    fake.recordingDelayMs = 500;
    const ctl = new AbortController();
    const p = caught(openProxyRecording('den', SUB, ctl.signal));
    setTimeout(() => ctl.abort(), 50);
    const err = await p;
    expect(err).not.toBeInstanceOf(ProxyError);
    expect(fallsBack(err, ctl.signal)).toBe(false);
  });

  it('rejects the read of a body that is cut short', async () => {
    fake.recordingDropAfter = 4;
    const got = await openProxyRecording('den', SUB);
    await expect(text(got.stream)).rejects.toBeDefined();
  });

  it('rejects the read of a body that stalls, once the idle time passes', async () => {
    fake.recordingStallAfter = 4;
    const got = await openProxyRecording('den', SUB, undefined, { idleMs: 150 });
    await expect(text(got.stream)).rejects.toThrow(/stalled/);
  });

  it('answers proxy_unreachable for a camera without a cam-proxy', async () => {
    setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]);
    resetProxyClients();
    expect(await caught(listProxyRecordings('den', 0, 1, 'sub'))).toMatchObject({ name: 'ProxyError', code: 'proxy_unreachable' });
  });

  it('logs a failure at warn, a 400 at error, never with the token', async () => {
    const lines: { level: string; text: string }[] = [];
    for (const level of ['warn', 'error'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => void lines.push({ level, text: inspect(a, { depth: 6 }) })) as never);
    }
    fake.recordingsOverride = { status: 503, body: { error: 'camera_offline' } };
    logProxyFailure('den', '20261001-211129-211209', await caught(openProxyRecording('den', SUB)));
    fake.recordingsOverride = { status: 400, body: { error: 'invalid' } };
    logProxyFailure('den', '20261001-211129-211209', await caught(openProxyRecording('den', SUB)));
    expect(lines.slice(0, 2).map((l) => l.level)).toEqual(['warn', 'error']);
    expect(lines[0].text).toContain('proxy_recordings_failed');
    expect(lines[0].text).toContain('20261001-211129-211209');
    expect(lines[0].text).toContain('camera_offline');
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'search_failed' } };
    logProxyFailure('den', 'x', await caught(openProxyRecording('den', SUB)));
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'search_failed' } };
    logProxyFailure('den', 'x', await caught(listProxyDays('den', '2026-10')));
    expect(lines[2].text).toContain('search_failed');
    expect(lines[3].text).toContain('search_failed');
    expect(lines.map((l) => l.text).join('\n')).not.toContain(FAKE_TOKEN);
  });
});

describe('listProxyDay (cam-proxy date=)', () => {
  const fb = { from: T0 - 1, to: T0 + 1 };
  it('asks with date and stream only', async () => {
    fake.recordings.set('cam1', []);
    expect(await listProxyDay('den', '2026-10-01', 'sub', fb)).toEqual([]);
    expect(fake.requests.at(-1)).toMatchObject({ path: '/api/cameras/cam1/recordings', query: { date: '2026-10-01', stream: 'sub' } });
    expect(fake.requests.at(-1)!.query.from).toBeUndefined();
  });
  it('asks once more with from and to when the proxy answers 400 (an older proxy ignores date and wants from/to)', async () => {
    fake.legacyRecordings = true;
    const before = fake.requests.length;
    const list = await listProxyDay('den', '2026-10-01', 'main', fb);
    expect(list.map((r) => r.id)).toEqual([MAIN]);
    const asks = fake.requests.slice(before);
    expect(asks.map((r) => Object.keys(r.query).sort())).toEqual([['date', 'stream'], ['from', 'stream', 'to']]);
  });
  it('does not retry other failures with from and to', async () => {
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } };
    const before = fake.requests.length;
    await expect(listProxyDay('den', '2026-10-01', 'sub', fb)).rejects.toMatchObject({ status: 502 });
    expect(fake.requests.length - before).toBe(1);
  });
  it('retries once after Retry-After on 503 busy, then gives up', async () => {
    fake.recordingsBusy = 1;
    const t = Date.now();
    expect((await listProxyDay('den', '2026-10-01', 'sub', fb)).length).toBe(1);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
    fake.recordingsBusy = 5;
    const before = fake.requests.length;
    await expect(listProxyDay('den', '2026-10-01', 'sub', fb)).rejects.toMatchObject({ status: 503, reason: 'busy' });
    expect(fake.requests.length - before).toBe(2);
  }, 15_000);

  it('stops waiting out a busy proxy when the viewer leaves', async () => {
    fake.recordingsBusy = 5;
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error('viewer left')), 200);
    const t = Date.now();
    await expect(listProxyDay('den', '2026-10-01', 'sub', fb, ctl.signal)).rejects.toThrow('viewer left');
    expect(Date.now() - t).toBeLessThan(800);
    const before = fake.requests.length;
    await expect(listProxyDay('den', '2026-10-01', 'sub', fb, AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
    expect(fake.requests.length).toBe(before);
  }, 15_000);
  it('remembers an older proxy for ten minutes: from/to at once, then date= again', async () => {
    fake.legacyRecordings = true;
    const now = vi.spyOn(Date, 'now');
    const t0 = 1_800_000_000_000;
    now.mockReturnValue(t0);
    let before = fake.requests.length;
    await listProxyDay('den', '2026-10-01', 'sub', fb);
    await listProxyDay('den', '2026-10-01', 'main', fb);
    expect(fake.requests.slice(before).map((r) => Object.keys(r.query).sort())).toEqual([['date', 'stream'], ['from', 'stream', 'to'], ['from', 'stream', 'to']]);
    now.mockReturnValue(t0 + 9 * 60_000);
    before = fake.requests.length;
    await listProxyDay('den', '2026-10-02', 'sub', fb);
    expect(fake.requests.length - before).toBe(1);
    now.mockReturnValue(t0 + 11 * 60_000);
    before = fake.requests.length;
    await listProxyDay('den', '2026-10-02', 'sub', fb);
    expect(fake.requests.slice(before).map((r) => Object.keys(r.query).sort())).toEqual([['date', 'stream'], ['from', 'stream', 'to']]);
  });
});
