import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy, type FakeRecording } from './proxy/fakeProxy';

// The fake's recordings routes follow cam-proxy's API (cam-proxy spec
// 2026-10-02-baichuan-recordings-design, section 2), so cams' tests meet the
// shapes and status codes the real proxy sends.
const SUB = 'RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4';
const MAIN = 'RecM0A_DST20261001_211129_211209_0_5514C080000000_66A92E.mp4';
const T0 = 1_790_000_000_000;

let fake: FakeProxy;
const get = (path: string, init: RequestInit = {}) =>
  fetch(`${fake.url}${path}`, { ...init, headers: { Authorization: `Bearer ${FAKE_TOKEN}`, ...(init.headers as Record<string, string> | undefined) } });

beforeEach(async () => {
  fake = await startFakeProxy();
  const rec = (id: string, stream: 'sub' | 'main', body: string): FakeRecording => ({ id, start: T0, end: T0 + 38_000, stream, body: Buffer.from(body) });
  fake.recordings.set('cam1', [rec(MAIN, 'main', 'main-bytes-'.repeat(20)), rec(SUB, 'sub', '0123456789')]);
});
afterEach(() => fake.stop());

describe('fake cam-proxy: recordings', () => {
  it('lists one stream overlapping [from, to], in cam-proxy’s shape', async () => {
    const r = await get(`/api/cameras/cam1/recordings?from=${T0 - 1000}&to=${T0 + 1000}&stream=sub`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([{ id: SUB, start: T0, end: T0 + 38_000, stream: 'sub', size: 10, kinds: [], clipId: null }]);
    expect(await (await get(`/api/cameras/cam1/recordings?from=${T0 + 60_000}&to=${T0 + 70_000}&stream=sub`)).json()).toEqual([]);
  });

  it('refuses a bad window, stream, id or month with 400 invalid', async () => {
    for (const q of ['from=1&to=0&stream=sub', 'from=0&to=1', 'from=0&to=1&stream=hd', `from=0&to=${48 * 3_600_000 + 1}&stream=sub`]) {
      const r = await get(`/api/cameras/cam1/recordings?${q}`);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('invalid');
    }
    expect((await get('/api/cameras/cam1/recordings/not-a-name.mp4')).status).toBe(400);
    expect((await get('/api/cameras/cam1/recordings/days?month=2026-13')).status).toBe(400);
  });

  it('answers 404 not_found for a camera it does not know, 503 camera_offline for a known one without recordings', async () => {
    for (const p of ['/api/cameras/nope/recordings?from=0&to=1&stream=sub', '/api/cameras/nope/recordings/days?month=2026-10', `/api/cameras/nope/recordings/${SUB}`]) {
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not_found' });
    }
    fake.camerasBody = [{ id: 'cam1' }, { id: 'den' }];
    for (const p of ['/api/cameras/den/recordings?from=0&to=1&stream=sub', '/api/cameras/den/recordings/days?month=2026-10', `/api/cameras/den/recordings/${SUB}`]) {
      const r = await get(p);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'camera_offline' });
    }
  });

  it('lists the days of a month that have recordings', async () => {
    expect(await (await get('/api/cameras/cam1/recordings/days?month=2026-10')).json()).toEqual({ month: '2026-10', days: [1] });
    expect(await (await get('/api/cameras/cam1/recordings/days?month=2026-09')).json()).toEqual({ month: '2026-09', days: [] });
  });

  it('serves a file with HEAD, Range and 416, and 404 unknown_recording for one it doesn’t have', async () => {
    const head = await get(`/api/cameras/cam1/recordings/${SUB}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(fake.recordingFetches).toEqual([]);
    const whole = await get(`/api/cameras/cam1/recordings/${SUB}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('cache-control')).toBe('private, max-age=604800, immutable');
    expect(Buffer.from(await whole.arrayBuffer()).toString()).toBe('0123456789');
    expect(fake.recordingFetches).toEqual([SUB]);
    const part = await get(`/api/cameras/cam1/recordings/${SUB}`, { headers: { Range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('234');
    const beyond = await get(`/api/cameras/cam1/recordings/${SUB}`, { headers: { Range: 'bytes=50-60' } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */10');
    const gone = await get('/api/cameras/cam1/recordings/RecS0A_DST20261001_000000_000010_0_5514C080000000_1.mp4');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'unknown_recording' });
  });

  it('answers recordingsOverride on every recordings route, and drops a file midway with recordingDropAfter', async () => {
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable', reason: 'refused' } };
    expect((await get('/api/cameras/cam1/recordings?from=0&to=1&stream=sub')).status).toBe(502);
    expect((await get('/api/cameras/cam1/recordings/days?month=2026-10')).status).toBe(502);
    expect((await get(`/api/cameras/cam1/recordings/${SUB}`)).status).toBe(502);
    fake.recordingsOverride = null;
    fake.recordingDropAfter = 4;
    const r = await get(`/api/cameras/cam1/recordings/${MAIN}`);
    expect(r.headers.get('content-length')).toBe('220');
    await expect(r.arrayBuffer()).rejects.toThrow();
  });

  it('wants the client token', async () => {
    expect((await fetch(`${fake.url}/api/cameras/cam1/recordings?from=0&to=1&stream=sub`)).status).toBe(401);
  });
});

describe('fake cam-proxy: recordings boundaries', () => {
  const list = async (q: string, cam = 'cam1') => get(`/api/cameras/${cam}/recordings?${q}`);

  it('lists a recording that only touches the window at its edge, not one a millisecond away', async () => {
    const ids = async (from: number, to: number) => ((await (await list(`from=${from}&to=${to}&stream=sub`)).json()) as { id: string }[]).map((x) => x.id);
    expect(await ids(T0 + 38_000, T0 + 40_000)).toEqual([SUB]); // starts where the recording ends
    expect(await ids(T0 - 5_000, T0)).toEqual([SUB]); // ends where the recording starts
    expect(await ids(T0 + 38_001, T0 + 40_000)).toEqual([]);
    expect(await ids(T0 - 5_000, T0 - 1)).toEqual([]);
  });

  it('takes a window of exactly 48 h and refuses one millisecond more', async () => {
    expect((await list(`from=0&to=${48 * 3_600_000}&stream=sub`)).status).toBe(200);
    expect((await list(`from=0&to=${48 * 3_600_000 + 1}&stream=sub`)).status).toBe(400);
  });

  it('takes from and to of up to 15 digits and refuses 16', async () => {
    expect((await list('from=100000000000000&to=100000000000000&stream=sub')).status).toBe(200);
    expect((await list('from=1000000000000000&to=1000000000000000&stream=sub')).status).toBe(400);
    expect((await list('from=0&to=1000000000000000&stream=sub')).status).toBe(400);
  });

  it('takes an id of 128 characters and refuses 129', async () => {
    const id = (n: number) => `RecS0A_20261001_211129_211207_${'A'.repeat(n - 'RecS0A_20261001_211129_211207_'.length - '.mp4'.length)}.mp4`;
    expect(id(128)).toHaveLength(128);
    expect((await get(`/api/cameras/cam1/recordings/${id(128)}`)).status).toBe(404); // well-formed, unknown
    const long = await get(`/api/cameras/cam1/recordings/${id(129)}`);
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: string }).error).toBe('invalid');
  });

  it('answers HEAD with Accept-Ranges and the length, without a transfer', async () => {
    const head = await get(`/api/cameras/cam1/recordings/${SUB}`, { method: 'HEAD' });
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('content-length')).toBe('10');
    expect(fake.recordingFetches).toEqual([]);
  });

  it('checks the input before the camera and the override, as the real proxy does', async () => {
    fake.recordingsOverride = { status: 502, body: { error: 'recordings_unavailable' } };
    expect((await list('from=1&to=0&stream=sub')).status).toBe(400);
    expect((await get('/api/cameras/cam1/recordings/not-a-name.mp4')).status).toBe(400);
    expect((await get('/api/cameras/cam1/recordings/days?month=2026-13')).status).toBe(400);
    fake.recordingsOverride = null;
    expect((await list('from=1&to=0&stream=sub', 'nope')).status).toBe(400); // bad input beats an unknown camera
    expect((await get('/api/cameras/nope/recordings/not-a-name.mp4')).status).toBe(400);
    expect((await list('from=0&to=1&stream=sub', 'nope')).status).toBe(404);
  });

  it('sends the same Cache-Control and a stable ETag when it drops a file midway', async () => {
    const whole = await get(`/api/cameras/cam1/recordings/${MAIN}`);
    const etag = whole.headers.get('etag');
    expect(etag).toBeTruthy();
    await whole.arrayBuffer();
    fake.recordingDropAfter = 4;
    const r = await get(`/api/cameras/cam1/recordings/${MAIN}`);
    expect(r.headers.get('cache-control')).toBe('private, max-age=604800, immutable');
    expect(r.headers.get('etag')).toBe(etag);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    await expect(r.arrayBuffer()).rejects.toThrow();
  });

  // cam-proxy v2026.10.02.4: one camera-local day by name, with the recording
  // that started the day before and runs past midnight into it.
  describe('date=', () => {
    const CROSS = 'RecS0A_DST20260930_233000_000500_0_5514C080000000_AAAAAA.mp4';
    const NEXT = 'RecS0A_DST20261002_000100_000200_0_5514C080000000_BBBBBB.mp4';
    const ids = async (q: string) => ((await (await get(`/api/cameras/cam1/recordings?${q}`)).json()) as { id: string }[]).map((x) => x.id);
    beforeEach(() => {
      const rec = (id: string, start: number): FakeRecording => ({ id, start, end: start + 1000, stream: 'sub', body: Buffer.from('x') });
      fake.recordings.set('cam1', [rec(CROSS, T0 - 3), rec(SUB, T0), rec(NEXT, T0 + 3), { ...rec(MAIN, T0), stream: 'main' }]);
    });

    it('lists the camera-local day, plus a recording from the day before that runs past midnight', async () => {
      // CROSS: 2026-09-30 23:30 to 2026-10-01 00:05, so part of Oct 1 as well as Sep 30.
      expect(await ids('date=2026-10-01&stream=sub')).toEqual([CROSS, SUB]);
      expect(await ids('date=2026-10-01&stream=main')).toEqual([MAIN]);
      expect(await ids('date=2026-09-30&stream=sub')).toEqual([CROSS]);
      expect(await ids('date=2026-10-02&stream=sub')).toEqual([NEXT]);
    });

    it('does not include a day-before recording that ends the same day', async () => {
      const same = 'RecS0A_DST20260930_100000_100500_0_5514C080000000_DDDDDD.mp4';
      fake.recordings.get('cam1')!.push({ id: same, start: T0 - 5, end: T0 - 4, stream: 'sub', body: Buffer.from('x') });
      expect(await ids('date=2026-10-01&stream=sub')).toEqual([CROSS, SUB]);
    });

    it('refuses date with from or to, a bad date, a year outside 2000 to 2099, and no stream with 400 invalid', async () => {
      for (const q of ['date=2026-10-01&from=0&stream=sub', 'date=2026-10-01&to=1&stream=sub', 'date=2026-10-01&from=0&to=1&stream=sub', 'date=2026-1-01&stream=sub', 'date=2026-02-30&stream=sub', 'date=1999-12-31&stream=sub', 'date=2100-01-01&stream=sub', 'date=2026-10-01']) {
        const r = await get(`/api/cameras/cam1/recordings?${q}`);
        expect(r.status, q).toBe(400);
        expect(((await r.json()) as { error: string }).error).toBe('invalid');
      }
    });

    it('answers 503 recordings_unavailable busy with Retry-After for the next recordingsBusy list requests', async () => {
      fake.recordingsBusy = 1;
      const r = await get('/api/cameras/cam1/recordings?date=2026-10-01&stream=sub');
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBe('1');
      expect(await r.json()).toEqual({ error: 'recordings_unavailable', reason: 'busy' });
      expect((await get('/api/cameras/cam1/recordings?date=2026-10-01&stream=sub')).status).toBe(200);
    });
  });
});
