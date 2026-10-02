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
      expect((await r.json()).error).toBe('invalid');
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
