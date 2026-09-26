import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { liveStreamCount, MAX_LIVE_PER_CAMERA } from '../server/routes/cameras';
import { logger } from '../server/logger';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createMockCamera, MockState } from './mock-camera/server';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
let camServer: Server;
let camState: MockState;
let appServer: Server;
let base: string;

beforeEach(async () => {
  const mock = createMockCamera({ user: 'u', password: 'p' });
  camState = mock.state;
  camServer = mock.app.listen(0);
  await new Promise((r) => camServer.once('listening', r));
  const port = (camServer.address() as AddressInfo).port;
  setCameras([
    { id: 'cam1', name: 'Den', host: `127.0.0.1:${port}`, protocol: 'http', user: 'u', password: 'p' },
    { id: 'down', name: 'Garage', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetClients();
  appServer = createApp().listen(0);
  await new Promise((r) => appServer.once('listening', r));
  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => camServer.close(() => r()));
  setCameras([]);
  resetClients();
});

// Opens a live stream through the app and resolves with the response once
// the first bytes arrive; the caller destroys it.
function openLive(quality = 'sub'): Promise<http.IncomingMessage & { first: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}/api/cameras/cam1/live?quality=${quality}`, { headers: { Cookie: auth } }, (res) => {
        if (res.statusCode !== 200) {
          resolve(Object.assign(res, { first: Buffer.alloc(0) }));
          return;
        }
        res.once('data', (chunk: Buffer) => resolve(Object.assign(res, { first: chunk })));
      })
      .on('error', reject);
  });
}
// Polls a condition instead of sleeping a fixed time, so assertions about
// async cleanup (releasing a slot, closing an upstream connection) fail fast
// when the condition is never met instead of just getting lucky on timing.
async function waitFor(predicate: () => boolean, { timeoutMs = 2000, intervalMs = 20 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('camera routes', () => {
  it('reports status for an online camera', async () => {
    const res = await request(appServer).get('/api/cameras/cam1/status').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'cam1', online: true, model: 'RLC-1224A', firmware: 'v3.2.0.6011_mock' });
  });

  it('reports an unreachable camera as offline with only an error code', async () => {
    const res = await request(appServer).get('/api/cameras/down/status').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'down', online: false, error: 'camera_offline' });
  });

  it('404s an unknown camera', async () => {
    const res = await request(appServer).get('/api/cameras/nope/status').set('Cookie', auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_camera' });
  });

  it('requires a session', async () => {
    expect((await request(appServer).get('/api/cameras/cam1/status')).status).toBe(401);
    expect((await request(appServer).get('/api/cameras/cam1/live')).status).toBe(401);
  });

  it('proxies a JPEG snapshot, uncached', async () => {
    const res = await request(appServer).get('/api/cameras/cam1/snapshot.jpg').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // Review focus 5: errors carry only a code.
  it('answers a snapshot from an unreachable camera with 503 and no details', async () => {
    const res = await request(appServer).get('/api/cameras/down/snapshot.jpg').set('Cookie', auth);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'camera_offline' });
  });

  // Regression coverage for the live route's error path (previously only the
  // snapshot route's 503 was tested): the slot must be freed promptly even
  // on a kept-alive connection, where the underlying socket stays open well
  // past the response completing.
  it('releases the stream slot as soon as the response finishes, even on a keep-alive connection', async () => {
    const agent = new http.Agent({ keepAlive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        http
          .get(`${base}/api/cameras/down/live`, { headers: { Cookie: auth }, agent }, (res) => {
            res.resume();
            res.on('end', resolve);
          })
          .on('error', reject);
      });
      await waitFor(() => liveStreamCount('down') === 0, { timeoutMs: 150 });
    } finally {
      agent.destroy();
    }
  });

  it('streams FLV from the camera', async () => {
    const res = await openLive();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/x-flv');
    expect(res.first.subarray(0, 3).toString()).toBe('FLV');
    res.destroy();
  });

  // Review focus 2: a closed tab releases the slot and the camera connection.
  it('releases the stream slot and closes the camera stream when the client disconnects', async () => {
    const res = await openLive();
    expect(liveStreamCount('cam1')).toBe(1);
    expect(camState.activeStreams).toBe(1);
    res.destroy();
    await waitFor(() => liveStreamCount('cam1') === 0);
    // Mutation coverage: this only reaches 0 because release() calls
    // abort.abort(), which cancels the still-open request to the camera.
    // Without it, the camera's own connection is never closed.
    await waitFor(() => camState.activeStreams === 0);
  });

  // Mutation coverage for Review focus 2: without `res.on('close', release)`,
  // liveStreamCount/activeStreams are only released once openLive() settles
  // on its own (after flvDelayMs), not when the viewer actually left. The
  // tight timeout below only passes if release happens promptly.
  it('releases the stream slot when the viewer disconnects before openLive() resolves', async () => {
    const flvDelayMs = 300;
    const slow = createMockCamera({ user: 'u', password: 'p', flvDelayMs });
    const slowServer = slow.app.listen(0);
    await new Promise((r) => slowServer.once('listening', r));
    const slowPort = (slowServer.address() as AddressInfo).port;
    try {
      setCameras([{ id: 'cam1', name: 'Den', host: `127.0.0.1:${slowPort}`, protocol: 'http', user: 'u', password: 'p' }]);
      resetClients();
      const req = http.get(`${base}/api/cameras/cam1/live`, { headers: { Cookie: auth } });
      req.on('error', () => {
        /* expected: we destroy this request ourselves below */
      });
      // The request must actually have reached the route (slot taken) before
      // the disconnect, or this test could pass without testing anything.
      await waitFor(() => liveStreamCount('cam1') === 1);
      await new Promise((r) => setTimeout(r, 50));
      req.destroy();
      // Well under flvDelayMs: only passes if the disconnect releases the
      // slot immediately, not after the delayed camera response arrives.
      await waitFor(() => liveStreamCount('cam1') === 0, { timeoutMs: 150 });
      // Mutation coverage: without abort.abort(), the pending request to the
      // camera is never cancelled, so the mock's delayed handler still runs
      // at flvDelayMs and starts a stream nobody is listening for. Wait past
      // that delay and confirm it never did.
      await new Promise((r) => setTimeout(r, flvDelayMs + 100));
      expect(slow.state.activeStreams).toBe(0);
    } finally {
      slowServer.closeAllConnections();
      await new Promise<void>((r) => slowServer.close(() => r()));
    }
  });

  it(`refuses more than ${MAX_LIVE_PER_CAMERA} concurrent streams per camera`, async () => {
    const open = await Promise.all(Array.from({ length: MAX_LIVE_PER_CAMERA }, () => openLive()));
    const extra = await request(appServer).get('/api/cameras/cam1/live').set('Cookie', auth);
    expect(extra.status).toBe(503);
    expect(extra.body).toEqual({ error: 'too_many_streams' });
    open.forEach((r) => r.destroy());
    await waitFor(() => liveStreamCount('cam1') === 0);
  });

  it('treats an unknown quality as sub', async () => {
    const res = await openLive('bogus');
    expect(res.statusCode).toBe(200);
    res.destroy();
  });

  // The camera dropping the connection mid-stream is not the viewer leaving:
  // it must be logged, unlike a normal disconnect.
  it('logs a warning when the camera drops the stream mid-transfer', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const res = await openLive();
      camState.dropStreams();
      await waitFor(() => warnSpy.mock.calls.some(([, msg]) => msg === 'camera_stream_failed'));
      const [fields, msg] = warnSpy.mock.calls.find(([, m]) => m === 'camera_stream_failed')!;
      expect(msg).toBe('camera_stream_failed');
      expect(fields).toMatchObject({ cameraId: 'cam1', code: 'stream_interrupted' });
      res.destroy();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
