// Live video of a through-proxy camera (spec §10.3): cams → proxy is a
// WebSocket (MSE: the MIME type, then fMP4), browser → cams stays chunked
// HTTP on the existing live route.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { liveStreamCount, recheckLiveStreams } from '../server/routes/cameras';
import { clearSecretBindings, setSecretGuard } from '../server/secretGuard';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN } from './proxy/fakeProxy';
import { startThroughProxy, type ThroughProxy } from './helpers/throughProxy';
import { k } from './helpers/fleet';
import { setReportedCapabilities } from '../server/cameraRegistry';

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
  // Code review 2026-11-09 (and #243 M2): an open live stream ends when its
  // sign-in no longer qualifies, at a new configuration or the periodic check.
  it('ends an open stream once the viewer is no longer allowed in', async () => {
    const res = await open();
    expect(res.statusCode).toBe(200);
    await read(res, 1000);
    const ended = new Promise<void>((r) => res.on('close', () => r()));
    const saved = process.env.ALLOWED_EMAILS;
    process.env.ALLOWED_EMAILS = 'someone-else@example.org';
    try {
      recheckLiveStreams();
      await Promise.race([ended, new Promise((_r, reject) => setTimeout(() => reject(new Error('still open')), 2000))]);
      expect(liveStreamCount(k('den'))).toBe(0);
    } finally {
      process.env.ALLOWED_EMAILS = saved;
    }
  }, 15_000);

  it('keeps it while the viewer still qualifies', async () => {
    const res = await open();
    await read(res, 1000);
    recheckLiveStreams();
    await new Promise((r) => setTimeout(r, 100));
    expect(liveStreamCount(k('den'))).toBe(1);
    res.destroy();
  }, 15_000);

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

  // The third stream (ext, the Reolink app's Balanced): only for a camera
  // whose proxy lists it in capabilities.live.
  it('passes quality=ext on as stream=ext for a camera that offers it', async () => {
    t.fake.capabilities.set('cam1', { schema: 1, ptz: null, live: ['main', 'ext', 'sub'] });
    setReportedCapabilities(k('den'), { schema: 1, ptz: null, live: ['main', 'ext', 'sub'] });
    const res = await open('quality=ext&codecs=avc1.640029');
    expect(res.statusCode).toBe(200);
    expect((await read(res, 1000)).subarray(4, 8).toString()).toBe('ftyp');
    res.destroy();
    expect(t.fake.liveRequests.at(-1)?.query).toEqual({ stream: 'ext', codecs: 'avc1.640029' });
  }, 15_000);

  it('answers 503 stream_not_offered for ext of a camera without it, without asking the proxy; the proxy refuses it too', async () => {
    setReportedCapabilities(k('den'), { schema: 1, ptz: null, live: ['main', 'sub'] });
    const res = await open('quality=ext');
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(await body(res))).toEqual({ error: 'stream_not_offered' });
    expect(t.fake.liveRequests).toEqual([]);
    expect(liveStreamCount(k('den'))).toBe(0);
    // Capabilities that say ext while the proxy doesn't (stale): the proxy's refusal comes through.
    setReportedCapabilities(k('den'), { schema: 1, ptz: null, live: ['main', 'ext', 'sub'] });
    const stale = await open('quality=ext');
    expect(stale.statusCode).toBe(503);
    expect(JSON.parse(await body(stale))).toEqual({ error: 'stream_not_offered' });
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
