import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { ProxyClient, resetProxyClients } from '../server/proxy/client';
import { ProxyStream, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

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
  it('passes on only its own camera’s messages when a proxy serves several (review #5)', async () => {
    const fake = await fakeProxy();
    const s = new ProxyStream('den', new ProxyClient({ url: fake.url, token: FAKE_TOKEN }), { backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200, remoteCam: 'cam1' });
    const got: { data: Record<string, unknown> }[] = [];
    s.on('message', (m) => got.push(m));
    s.start();
    cleanup.push(() => s.stop());
    await until(() => s.up());
    fake.push({ cam: 'barn', type: 'camera-event', data: { eventId: 1, kind: 'person', phase: 'start', ts: 1000 } });
    fake.push({ cam: 'cam1', type: 'camera-event', data: { eventId: 2, kind: 'motion', phase: 'start', ts: 2000 } });
    await until(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((m) => m.data.eventId)).toEqual([2]);
  });

  it('relays the proxy’s messages and reports up', async () => {
    const fake = await fakeProxy();
    const { s, got, states } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'camera-event', data: { eventId: 1, kind: 'person', phase: 'start', ts: 1000 } });
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ cam: 'den', type: 'camera-event', data: { eventId: 1, kind: 'person', phase: 'start' } });
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
