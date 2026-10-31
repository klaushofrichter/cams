// The proxy's camera calls (cam-proxy plan 2026-10-31-camera-calls-for-cams
// Task 1): the status answer parsed field by field, its time as cams's
// TimeInfo, the admin client for camera-changing calls.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCameras, type FileCameraConfig } from '../server/cameraRegistry';
import { ProxyError, resetProxyClients } from '../server/proxy/client';
import { parseProxyStatus, proxyAdminClient, proxyTimeInfo, readProxyStatus, resetProxyCameraCalls } from '../server/proxy/cameraCalls';
import { offsetAt, timeInfoFromGetTime, timeInfoFromProxy } from '../server/recordings/clipNames';
import { FAKE_ADMIN_TOKEN, FAKE_TOKEN, fakeStatus, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { k } from './helpers/fleet';

const US_RULE = { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0 };
let fake: FakeProxy;
const cam = (id: string, proxy: FileCameraConfig['proxy']): FileCameraConfig => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy });

beforeEach(async () => {
  fake = await startFakeProxy();
  setCameras([cam('den', { url: fake.url, token: FAKE_TOKEN, adminToken: FAKE_ADMIN_TOKEN, camera: 'cam1' }), cam('shed', { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' })]);
  resetProxyClients();
  resetProxyCameraCalls();
});
afterEach(async () => {
  await fake.stop();
  setCameras([]);
});

describe('parseProxyStatus', () => {
  it('keeps a full answer', () => {
    const s = parseProxyStatus(fakeStatus());
    expect(s).toMatchObject({
      online: true,
      error: null,
      model: 'RLC-1224A',
      streams: { main: { codec: 'h265', width: 3840, height: 2160, fps: 20 }, sub: { codec: 'h264', width: 640, height: 360, fps: 15 } },
      sd: { mounted: true, capacityMB: 120000, freeMB: 60000 },
      credentials: { source: 'store', authOk: true },
      tls: { mode: 'none', served: null, problem: null },
    });
    expect(s?.time).toMatchObject({ stdOffsetMinutes: -360, dstOffsetMinutes: 60 });
  });

  it('nulls each bad field, and the whole answer without online', () => {
    const s = parseProxyStatus({
      ...fakeStatus(),
      model: 5,
      firmware: 'x'.repeat(300),
      streams: { main: { codec: 'vp9', width: 1, height: 1, fps: 1 }, sub: 'no' },
      sd: { mounted: 'yes' },
      time: { stdOffsetMinutes: 'a' },
      certificate: { subject: 1 },
      credentials: { source: 'secret', authOk: 'x' },
      tls: { mode: 7, served: 'bad', problem: 'odd' },
    });
    expect(s).toMatchObject({ online: true, model: null, firmware: null, streams: { main: null, sub: null }, sd: null, time: null, certificate: null, credentials: { source: 'none', authOk: null }, tls: { mode: 'unknown', served: null, problem: null } });
    expect(parseProxyStatus({ ...fakeStatus(), online: 'yes' })).toBeNull();
    expect(parseProxyStatus(null)).toBeNull();
  });
});

describe('timeInfoFromProxy', () => {
  it('gives the same offset as the camera\'s GetTime on both DST edges', () => {
    const direct = timeInfoFromGetTime({ Time: { timeZone: 21600 }, Dst: { enable: 1, offset: 1, ...US_RULE } });
    const proxied = timeInfoFromProxy({ clockOffsetMs: 12, stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: US_RULE });
    expect(proxied).toEqual(direct);
    for (const at of [Date.UTC(2026, 2, 8, 7, 59), Date.UTC(2026, 2, 8, 8, 1), Date.UTC(2026, 10, 1, 6, 59), Date.UTC(2026, 10, 1, 7, 1)]) {
      expect(offsetAt(proxied!, at)).toBe(offsetAt(direct, at));
    }
  });

  it('takes no rule and refuses junk', () => {
    expect(timeInfoFromProxy({ stdOffsetMinutes: 60, dstOffsetMinutes: 0, dstRule: null })).toEqual({ stdOffsetMinutes: 60, dstOffsetMinutes: 0 });
    expect(timeInfoFromProxy({ stdOffsetMinutes: 'x' })).toBeNull();
    expect(timeInfoFromProxy(null)).toBeNull();
  });
});

describe('readProxyStatus', () => {
  it('reads the camera\'s status with the client token', async () => {
    const s = await readProxyStatus(k('den'));
    expect(s.online).toBe(true);
    const r = fake.requests.find((x) => x.path === '/api/cameras/cam1/status');
    expect(r?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('throws a ProxyError when the proxy is gone', async () => {
    fake.offline = true;
    await expect(readProxyStatus(k('den'), { timeoutMs: 1000 })).rejects.toBeInstanceOf(ProxyError);
  });
});

describe('proxyAdminClient', () => {
  it('uses the admin token', async () => {
    const c = proxyAdminClient(k('den'));
    await c.json('/control/login-links', undefined).catch(() => undefined);
    expect(fake.requests.at(-1)?.auth).toBe(`Bearer ${FAKE_ADMIN_TOKEN}`);
  });

  it('throws proxy_admin_missing without one', () => {
    expect(() => proxyAdminClient(k('shed'))).toThrow(expect.objectContaining({ code: 'proxy_admin_missing' }));
  });
});

describe('proxyTimeInfo', () => {
  it('shares one read between callers at once, and caches it', async () => {
    const [a, b] = await Promise.all([proxyTimeInfo(k('den')), proxyTimeInfo(k('den'))]);
    expect(a).toEqual(b);
    await proxyTimeInfo(k('den'));
    expect(fake.requests.filter((x) => x.path === '/api/cameras/cam1/status')).toHaveLength(1);
  });
});
