import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { ProxyClient, resetProxyClients } from '../server/proxy/client';
import { ProxyStream, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { getAnalysisStore, resetAnalysisStore } from '../server/proxy/analyses';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { k } from './helpers/fleet';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fakeProxy(): Promise<FakeProxy> {
  const fake = await startFakeProxy();
  cleanup.push(() => fake.stop());
  return fake;
}

function stream(fake: FakeProxy, token = FAKE_TOKEN) {
  const s = new ProxyStream('den', new ProxyClient({ url: fake.url, token }), { backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
  const got: { type: string; data: Record<string, unknown> }[] = [];
  const states: boolean[] = [];
  s.on('message', (m) => got.push(m));
  s.on('state', (up: boolean) => states.push(up));
  s.start();
  cleanup.push(() => s.stop());
  return { s, got, states };
}

describe('ProxyStream (upstream)', () => {
  it('asks for analyses too', async () => {
    const fake = await fakeProxy();
    const { s, got } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'analysis', data: { eventId: 5, kind: 'person', start: 1000, summary: [] } });
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ type: 'analysis', data: { eventId: 5 } });
  });

  it('asks again without analyses when an older proxy refuses the type', async () => {
    const fake = await fakeProxy();
    fake.knownTypes = ['camera-event', 'camera-status', 'clip'];
    const { s, got } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'camera-event', data: { eventId: 1, kind: 'person', phase: 'start', ts: 1000 } });
    await until(() => got.length === 1);
    expect(got[0].type).toBe('camera-event');
    const asks = fake.requests.filter((r) => r.path === '/api/stream').map((r) => String(r.query.types).split(','));
    // Asked with analysis, camera (the camera's name, newer still),
    // still-check (cams #179) and archive (the Archive), then without each
    // refused type, no loop.
    expect(asks).toHaveLength(5);
    expect(asks[0]).toEqual(expect.arrayContaining(['analysis', 'camera', 'still-check', 'archive']));
    expect(asks[1]).not.toContain('analysis');
    expect(asks[4]).toEqual(['camera-event', 'camera-status', 'clip']);
  });

  it('asks for still checks, and without them from a proxy that has only analyses (cams #179)', async () => {
    const fake = await fakeProxy();
    fake.knownTypes = ['camera-event', 'camera-status', 'clip', 'analysis', 'camera'];
    const { s, got } = stream(fake);
    await until(() => s.up());
    const asks = fake.requests.filter((r) => r.path === '/api/stream').map((r) => String(r.query.types).split(','));
    expect(asks).toHaveLength(3);
    expect(asks[0]).toContain('still-check');
    expect(asks[2]).toEqual(['camera-event', 'camera-status', 'clip', 'analysis', 'camera']);
    fake.knownTypes = null;
    fake.push({ cam: 'den', type: 'analysis', data: { eventId: 5, kind: 'person', start: 1000, summary: [] } });
    await until(() => got.length === 1);
  });

  it('passes on still-check messages', async () => {
    const fake = await fakeProxy();
    const { s, got } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'still-check', data: { id: 17, stillTs: 5000, summary: [], events: [] } });
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ type: 'still-check', data: { id: 17, stillTs: 5000 } });
  });

  it('asks for analyses again after a drop, in case the proxy was upgraded (issue #109)', async () => {
    const fake = await fakeProxy();
    fake.knownTypes = ['camera-event', 'camera-status', 'clip'];
    const { s } = stream(fake);
    await until(() => s.up());
    const asks = () => fake.requests.filter((r) => r.path === '/api/stream').map((r) => String(r.query.types).split(','));
    const before = asks().length;
    fake.knownTypes = null; // the proxy restarts as a newer version
    fake.dropStreams();
    await until(() => asks().length > before && s.up());
    expect(asks().at(-1)).toEqual(expect.arrayContaining(['analysis', 'camera']));
  });

  it('keeps asking for analyses after a 400 that is not about the type', async () => {
    const fake = await fakeProxy();
    fake.streamStatus = 400;
    stream(fake);
    const asks = () => fake.requests.filter((r) => r.path === '/api/stream');
    await until(() => asks().length >= 2);
    for (const r of asks()) expect(String(r.query.types).split(',')).toContain('analysis');
  });

  it('relays the proxy’s messages and reports up', async () => {
    const fake = await fakeProxy();
    const { s, got, states } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'camera-event', data: { eventId: 1, kind: 'person', phase: 'start', ts: 1000 } });
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ remote: 'den', type: 'camera-event', data: { eventId: 1, kind: 'person', phase: 'start' } });
    expect(states).toEqual([true]);
    expect(fake.requests.find((r) => r.path === '/api/stream')?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('resumes after a drop from the last id, missing nothing', async () => {
    const fake = await fakeProxy();
    const { s, got } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'clip', data: { clipId: 1 } });
    await until(() => got.length === 1);
    fake.dropStreams();
    fake.push({ cam: 'den', type: 'clip', data: { clipId: 2 } }); // while disconnected
    await until(() => got.length === 2);
    expect(got.map((m) => m.data.clipId)).toEqual([1, 2]);
    expect(fake.requests.filter((r) => r.path === '/api/stream').length).toBeGreaterThanOrEqual(2);
  });

  it('on reset, starts over and tells listeners to reload', async () => {
    const fake = await fakeProxy();
    const { s, got } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'clip', data: { clipId: 1 } });
    await until(() => got.length === 1);
    fake.oldestId = 50; // the proxy's retention moved past our cursor
    fake.dropStreams();
    await until(() => got.some((m) => m.type === 'reset'));
  });

  it('goes down while the proxy is away, and comes back', async () => {
    const fake = await fakeProxy();
    const { s, states } = stream(fake);
    await until(() => s.up());
    fake.offline = true;
    fake.dropStreams();
    await until(() => !s.up());
    fake.offline = false;
    await until(() => s.up(), 3000);
    expect(states).toEqual([true, false, true]);
  });

  // Issue #38: an upstream error status (a crashing proxy) is down too, and retried.
  it('treats a 5xx from the stream as down, and comes back', async () => {
    const fake = await fakeProxy();
    const { s, states } = stream(fake);
    await until(() => s.up());
    fake.streamStatus = 500;
    fake.dropStreams();
    await until(() => !s.up());
    fake.streamStatus = null;
    await until(() => s.up(), 3000);
    expect(states).toEqual([true, false, true]);
  });

  // Final review I3: an upstream that goes quiet without closing (a vanished
  // pod, a lost network) counts as down after idleMs (cam-proxy pings every
  // 15 s), and is reconnected.
  it('treats a silent upstream as down and reconnects', async () => {
    const fake = await fakeProxy(); // the fake never pings
    const s = new ProxyStream('den', new ProxyClient({ url: fake.url, token: FAKE_TOKEN }), { backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200, idleMs: 300 });
    const states: boolean[] = [];
    s.on('state', (up: boolean) => states.push(up));
    s.start();
    cleanup.push(() => s.stop());
    await until(() => states.length >= 3, 3000);
    expect(states.slice(0, 3)).toEqual([true, false, true]);
    expect(fake.requests.filter((r) => r.path === '/api/stream').length).toBeGreaterThanOrEqual(2);
  });

  it('a refused token is down, retried slowly, never logged', async () => {
    const fake = await fakeProxy();
    const { s } = stream(fake, 'wrong-token-'.padEnd(40, 'w'));
    await new Promise((r) => setTimeout(r, 300));
    expect(s.up()).toBe(false);
    expect(s.lastError()).toBe('proxy_unauthorized');
    expect(fake.requests.filter((r) => r.path === '/api/stream').length).toBeLessThanOrEqual(2);
  });
});

describe('GET /api/events/stream (to browsers)', () => {
  const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;

  it('tells browsers about a new analysis, and keeps it for the day’s cards', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-30T16:00:00-05:00'), toFake: ['Date'] }); // the store forgets analyses two days after their start
    cleanup.push(() => vi.useRealTimers());
    resetAnalysisStore();
    const fake = await fakeProxy();
    const base = await app(fake);
    const c = open(base, auth);
    await until(() => c.frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    const start = Date.parse('2026-09-30T15:48:20-05:00');
    fake.push({ cam: 'den', type: 'analysis', data: { eventId: 9, kind: 'person', start, end: null, provider: 'google-vision', status: 'ok', reason: null, stillTs: start + 1000, summary: [], objects: [{ name: 'Fan', score: 0.9 }] } });
    await until(() => c.frames.some((f) => f.startsWith('event: change')));
    const change = c.frames.find((f) => f.startsWith('event: change'))!;
    expect(JSON.parse(change.split('data: ')[1])).toEqual({ cam: 'den', type: 'analysis', ts: start });
    expect(c.frames.join('\n')).not.toContain('Fan'); // the objects stay on the server
    const got = await getAnalysisStore().forDay(k('den'), '2026-09-30', [{ start: '2026-09-30T15:48:24-05:00', end: '2026-09-30T15:48:40-05:00' }], start);
    expect(got.map((x) => x.eventId)).toEqual([9]);
  });

  it('tells browsers about a new still check, at its second (cams #179)', async () => {
    const fake = await fakeProxy();
    const base = await app(fake);
    const c = open(base, auth);
    await until(() => c.frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    fake.push({ cam: 'den', type: 'still-check', data: { id: 17, stillTs: 1791130800000, provider: 'google-vision', summary: [], objects: [{ name: 'Fan', score: 0.9 }], events: [] } });
    await until(() => c.frames.some((f) => f.startsWith('event: change')));
    const change = c.frames.find((f) => f.startsWith('event: change'))!;
    expect(JSON.parse(change.split('data: ')[1])).toEqual({ cam: 'den', type: 'still-check', ts: 1791130800000 });
    expect(c.frames.join('\n')).not.toContain('Fan');
  });

  // cam-proxy's archive contract §7: the Archive page reloads on it; the items stay on the server.
  it('tells browsers the Archive changed: the action and the ids only', async () => {
    const fake = await fakeProxy();
    const base = await app(fake);
    const c = open(base, auth);
    await until(() => c.frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    fake.push({ cam: 'den', type: 'archive', data: { action: 'add', ids: [12, 'x'], items: [{ id: 12, name: 'Fox at the door', urls: { video: '/api/archive/12/video' } }] } });
    fake.push({ cam: 'den', type: 'archive', data: { action: 'explode', ids: [1] } });
    fake.push({ cam: 'den', type: 'archive', data: { action: 'expire', ids: [3, 4] } });
    await until(() => c.frames.filter((f) => f.startsWith('event: archive')).length === 2);
    const got = c.frames.filter((f) => f.startsWith('event: archive')).map((f) => JSON.parse(f.split('data: ')[1]));
    expect(got).toEqual([{ cam: 'den', action: 'add', ids: [12] }, { cam: 'den', action: 'expire', ids: [3, 4] }]);
    expect(c.frames.join('\n')).not.toContain('Fox');
    expect(c.frames.some((f) => f.startsWith('event: change'))).toBe(false);
  });

  async function app(fake: FakeProxy) {
    setCameras([
      { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } },
      { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
    ]);
    resetProxyClients();
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 });
    const server = http.createServer(createApp()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    cleanup.push(() => {
      stopProxyStreams();
      server.closeAllConnections();
      server.close();
      setCameras([]);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  // Reads SSE frames from a browser-side connection.
  function open(base: string, cookie?: string) {
    const frames: string[] = [];
    let status = 0;
    const req = http.get(`${base}/api/events/stream`, { headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      status = res.statusCode ?? 0;
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          frames.push(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      });
    });
    req.on('error', () => undefined);
    cleanup.push(() => req.destroy());
    return { frames, status: () => status };
  }

  it('needs a signed-in user', async () => {
    const fake = await fakeProxy();
    const base = await app(fake);
    const c = open(base);
    await until(() => c.status() !== 0);
    expect(c.status()).toBe(401);
  });

  it('sends the proxy state, then a change per proxy message, without tokens or URLs', async () => {
    const fake = await fakeProxy();
    const base = await app(fake);
    const c = open(base, auth);
    await until(() => c.frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    expect(c.frames[0]).toMatch(/^retry: 5000/);
    fake.push({ cam: 'den', type: 'clip', data: { clipId: 7, start: 1790538436000, url: '/api/cameras/den/clips/7.mp4' } });
    await until(() => c.frames.some((f) => f.startsWith('event: change')));
    const change = c.frames.find((f) => f.startsWith('event: change'))!;
    expect(JSON.parse(change.split('data: ')[1])).toEqual({ cam: 'den', type: 'clip', ts: 1790538436000 });
    const all = c.frames.join('\n');
    expect(all).not.toContain(FAKE_TOKEN);
    expect(all).not.toContain(fake.url);
    expect(all).not.toContain('clips/7.mp4');
  });

  it('says what kind of event started, for the live notification (Klaus, 2026-09-28)', async () => {
    const fake = await fakeProxy();
    const base = await app(fake);
    const c = open(base, auth);
    await until(() => c.frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    fake.push({ cam: 'den', type: 'camera-event', data: { eventId: 3, kind: 'person', phase: 'start', ts: 1790538436000, source: 'onvif' } });
    await until(() => c.frames.some((f) => f.startsWith('event: change')));
    const change = c.frames.find((f) => f.startsWith('event: change'))!;
    expect(JSON.parse(change.split('data: ')[1])).toEqual({ cam: 'den', type: 'camera-event', ts: 1790538436000, kind: 'person', phase: 'start' });
  });

  it('keeps browsers connected while the proxy is down, telling them', async () => {
    const fake = await fakeProxy();
    const base = await app(fake);
    const c = open(base, auth);
    await until(() => c.frames.some((f) => f.includes('"up":true')));
    fake.offline = true;
    fake.dropStreams();
    await until(() => c.frames.some((f) => f.includes('"up":false')));
    expect(c.status()).toBe(200);
  });
});
