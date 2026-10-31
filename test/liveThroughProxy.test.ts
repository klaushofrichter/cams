// Live video of a through-proxy camera (spec §10.3): cams → proxy is a
// WebSocket (MSE: the MIME type, then fMP4), browser → cams stays chunked
// HTTP on the existing live route.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { liveStreamCount } from '../server/routes/cameras';
import { clearSecretBindings, setSecretGuard } from '../server/secretGuard';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN } from './proxy/fakeProxy';
import { startThroughProxy, type ThroughProxy } from './helpers/throughProxy';
import { k } from './helpers/fleet';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
let t: ThroughProxy;
let app: Server;
let base: string;

beforeEach(async () => {
  t = await startThroughProxy();
  app = createApp().listen(0);
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterEach(async () => {
  setSecretGuard(false);
  clearSecretBindings();
  expect(t.sim.loginAttempts).toBe(0);
  await new Promise<void>((r) => app.close(() => r()));
  await t.close();
});

// The live response, once its headers are in (the body still flowing).
function open(query = 'quality=sub'): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get(`${base}/api/cameras/den/live?${query}`, { headers: { Cookie: auth } }, resolve).on('error', reject);
  });
}
const read = (res: http.IncomingMessage, bytes: number, ms = 5000): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const timer = setTimeout(() => reject(new Error(`only ${n} bytes`)), ms);
    res.on('data', (c: Buffer) => {
      chunks.push(c);
      n += c.length;
      if (n >= bytes) {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      }
    });
  });
const body = (res: http.IncomingMessage): Promise<string> => new Promise((r) => {
  let s = '';
  res.on('data', (c) => (s += c));
  res.on('end', () => r(s));
});

describe('live through the proxy', () => {
  it('relays fMP4 with the proxy\'s MIME type', async () => {
    const res = await open();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4; codecs="avc1.640029"');
    expect(res.headers['x-accel-buffering']).toBe('no');
    const first = await read(res, 2000);
    expect(first.subarray(4, 8).toString()).toBe('ftyp');
    const before = first.length;
    const more = await read(res, before + 20_000, 4000);
    expect(more.length).toBeGreaterThan(before);
    res.destroy();
    expect(t.fake.liveRequests.at(-1)?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
  }, 15_000);

  it('passes quality and codecs on and refuses bad codecs', async () => {
    const res = await open('quality=main&codecs=avc1.64002A');
    expect(res.statusCode).toBe(200);
    res.destroy();
    expect(t.fake.liveRequests.at(-1)?.query).toEqual({ stream: 'main', codecs: 'avc1.64002A' });
    const bad = await open(`quality=sub&codecs=${encodeURIComponent('a"b')}`);
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(await body(bad))).toMatchObject({ error: 'invalid' });
  }, 15_000);

  it('closes the proxy socket when the viewer leaves and frees the slot', async () => {
    const res = await open();
    await read(res, 1000);
    expect(t.fake.liveOpen()).toBe(1);
    expect(liveStreamCount(k('den'))).toBe(1);
    res.destroy();
    await expect.poll(() => t.fake.liveOpen(), { timeout: 3000 }).toBe(0);
    await expect.poll(() => liveStreamCount(k('den'))).toBe(0);
  }, 15_000);

  it('ends the response when the proxy closes', async () => {
    const res = await open();
    await read(res, 1000);
    const ended = new Promise<void>((r) => res.on('close', () => r()));
    t.fake.closeLive();
    await ended;
    await expect.poll(() => liveStreamCount(k('den'))).toBe(0);
  }, 15_000);

  it('cuts a viewer that stops reading', async () => {
    const res = await open();
    await read(res, 1000);
    res.pause();
    res.socket.pause();
    // The proxy keeps sending; cams queues past 4 MiB and cuts the viewer.
    t.fake.liveFlood();
    await expect.poll(() => liveStreamCount(k('den')), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => t.fake.liveOpen(), { timeout: 3000 }).toBe(0);
    res.destroy();
  }, 20_000);

  it.each(['camera_offline', 'too_many_streams', 'stream_unavailable'])('answers 503 %s when the proxy sends that error, before any byte', async (value) => {
    t.fake.liveRefusal = value;
    const res = await open();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(await body(res))).toEqual({ error: value });
    expect(liveStreamCount(k('den'))).toBe(0);
  });

  it('answers 502 proxy_unavailable when the proxy refuses the upgrade or is gone', async () => {
    t.fake.token = 'another-token-'.padEnd(48, 'x');
    const res = await open();
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(await body(res))).toEqual({ error: 'proxy_unavailable' });
  });

  it('never sends the token to an unconfirmed endpoint', async () => {
    setSecretGuard(true); // nothing bound
    const res = await open();
    expect(res.statusCode).toBe(502);
    await body(res);
    expect(t.fake.liveRequests).toEqual([]);
  });
});
