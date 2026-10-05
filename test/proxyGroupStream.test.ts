// test/proxyGroupStream.test.ts
// One upstream event stream per cam-proxy (cam-proxy spec 2026-10-05 §12.2),
// fanned out to the cams cameras mapped from each message's `cam`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras, type CameraConfig } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { proxyHub, proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { loadProxyState } from '../server/proxyState';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const OPTS = { backoffMinMs: 50, backoffMaxMs: 400, healthyMs: 200 };
const cam = (id: string, proxy?: CameraConfig['proxy']): CameraConfig => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', ...(proxy && { proxy }) });
const fakes: FakeProxy[] = [];
let got: { cam: string; type: string; data: Record<string, unknown> }[];
const onMessage = (m: { cam: string; type: string; data: Record<string, unknown> }) => got.push(m);

beforeEach(() => {
  process.env.PROXY_STATE_FILE = join(mkdtempSync(join(tmpdir(), 'cams-gs-')), 'proxy-state.json');
  loadProxyState();
  resetProxyClients();
  got = [];
  proxyHub.on('message', onMessage);
});
afterEach(async () => {
  proxyHub.off('message', onMessage);
  stopProxyStreams();
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  setCameras([]);
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

async function fake(): Promise<FakeProxy> {
  const f = await startFakeProxy();
  fakes.push(f);
  return f;
}
const streamAsks = (f: FakeProxy) => f.requests.filter((r) => r.path === '/api/stream');
const allUp = (ids: string[]) => ids.every((id) => proxyStates().find((s) => s.cam === id)?.up);

describe('one stream per proxy', () => {
  it('opens one upstream for two cameras, asking for both ids', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('shed'), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    expect(a.streamConnections()).toBe(1);
    expect(streamAsks(a).at(-1)?.query.cam).toBe('barn,cam1');
    expect(proxyStates()).toEqual([{ cam: 'den', up: true }, { cam: 'barn', up: true }]);
  });

  it('fans each message out to the camera mapped from its cam', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    a.push({ cam: 'barn', type: 'clip', data: { clipId: 2 } });
    await expect.poll(() => got.length).toBe(2);
    expect(got.map((m) => [m.cam, m.data.clipId])).toEqual([['den', 1], ['barn', 2]]);
  });

  it('drops cameras it doesn’t map', async () => {
    const a = await fake();
    a.camFilter = false; // sends every camera, so cams's own filter is what's tested
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam9', type: 'clip', data: { clipId: 9 } });
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    await expect.poll(() => got.length).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((m) => m.cam)).toEqual(['den']);
  });

  it('sends a reset and the state to every camera of the proxy', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    await expect.poll(() => got.length).toBe(1);
    a.oldestId = 100; // the proxy lost our place
    a.dropStreams();
    await expect.poll(() => got.filter((m) => m.type === 'reset').map((m) => m.cam).sort()).toEqual(['barn', 'den']);
    a.offline = true;
    a.dropStreams();
    await expect.poll(() => proxyStates().every((s) => !s.up)).toBe(true);
  });

  it('resumes both cameras after a drop, missing nothing, doubling nothing', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    await expect.poll(() => got.length).toBe(1);
    a.dropStreams();
    a.push({ cam: 'barn', type: 'clip', data: { clipId: 2 } }); // while disconnected
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 3 } });
    await expect.poll(() => got.length).toBe(3);
    await new Promise((r) => setTimeout(r, 150));
    expect(got.map((m) => [m.cam, m.data.clipId])).toEqual([['den', 1], ['barn', 2], ['den', 3]]);
  });

  it('keeps today’s one stream per one-camera proxy (the cluster: the Pi’s and its own)', async () => {
    const [a, b] = [await fake(), await fake()];
    setCameras([cam('cam1', { url: a.url, token: FAKE_TOKEN }), cam('cam2', { url: b.url, token: FAKE_TOKEN, camera: 'cam1' })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['cam1', 'cam2'])).toBe(true);
    expect([a.streamConnections(), b.streamConnections()]).toEqual([1, 1]);
    expect([streamAsks(a).at(-1)?.query.cam, streamAsks(b).at(-1)?.query.cam]).toEqual(['cam1', 'cam1']);
  });
});

describe('the Settings switch on a shared proxy', () => {
  const put = (id: string, enabled: boolean) => request(createApp()).put(`/api/cameras/${id}/proxy`).set('Cookie', auth).send({ enabled });

  it('re-subscribes on the switch, and closes with the last camera', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    const states: { cam: string; up: boolean }[] = [];
    const onState = (s: { cam: string; up: boolean }) => states.push(s);
    proxyHub.on('state', onState);
    try {
      expect((await put('barn', false)).status).toBe(200);
      await expect.poll(() => streamAsks(a).at(-1)?.query.cam).toBe('cam1');
      await expect.poll(() => a.streamConnections()).toBe(1);
      expect(states).toContainEqual({ cam: 'barn', up: false });
      expect(proxyStates()).toEqual([{ cam: 'den', up: true }]);
      expect((await put('den', false)).status).toBe(200);
      await expect.poll(() => a.streamConnections()).toBe(0);
      expect(proxyStates()).toEqual([]);
      expect((await put('barn', true)).status).toBe(200);
      await expect.poll(() => allUp(['barn'])).toBe(true);
      expect(streamAsks(a).at(-1)?.query.cam).toBe('barn');
      expect(a.streamConnections()).toBe(1);
    } finally {
      proxyHub.off('state', onState);
    }
  });

  it('gives a camera switched back on nothing old from the shared stream’s replay (review #2)', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    a.push({ cam: 'cam1', type: 'clip', data: { clipId: 1, start: Date.now() } });
    await expect.poll(() => got.length).toBe(1);
    expect((await put('barn', false)).status).toBe(200);
    await expect.poll(() => streamAsks(a).at(-1)?.query.cam).toBe('cam1');
    const old = Date.now() - 3_600_000;
    a.push({ cam: 'barn', type: 'camera-event', data: { eventId: 7, kind: 'person', phase: 'start', ts: old } });
    a.push({ cam: 'barn', type: 'clip', data: { clipId: 8, start: old } });
    got = [];
    expect((await put('barn', true)).status).toBe(200);
    await expect.poll(() => streamAsks(a).at(-1)?.query.cam).toBe('barn,cam1');
    a.push({ cam: 'barn', type: 'camera-event', data: { eventId: 9, kind: 'person', phase: 'start', ts: Date.now() } });
    await expect.poll(() => got.filter((m) => m.type === 'camera-event').length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 150));
    // The old event's notice is gone; the replayed clip is only a reload hint (the switch reset reloads anyway).
    expect(got.filter((m) => m.type === 'camera-event').map((m) => m.data.eventId)).toEqual([9]);
  });

  it('passes on new messages timed by an older moment right after the switch (re-review)', async () => {
    const a = await fake();
    setCameras([cam('den', { url: a.url, token: FAKE_TOKEN, camera: 'cam1' }), cam('barn', { url: a.url, token: FAKE_TOKEN })]);
    startProxyStreams(OPTS);
    await expect.poll(() => allUp(['den', 'barn'])).toBe(true);
    expect((await put('barn', false)).status).toBe(200);
    await expect.poll(() => streamAsks(a).at(-1)?.query.cam).toBe('cam1');
    expect((await put('barn', true)).status).toBe(200);
    await expect.poll(() => streamAsks(a).at(-1)?.query.cam).toBe('barn,cam1');
    got = [];
    const now = Date.now();
    a.push({ cam: 'barn', type: 'clip', data: { clipId: 1, start: now - 20_000, end: now } });
    a.push({ cam: 'barn', type: 'analysis', data: { eventId: 2, kind: 'person', start: now - 30_000, end: now - 1000, summary: [] } });
    a.push({ cam: 'barn', type: 'still-check', data: { id: 3, stillTs: now - 3_600_000, requestedAt: now, summary: [], events: [] } });
    await expect.poll(() => got.filter((m) => m.type !== 'reset').map((m) => m.type)).toEqual(['clip', 'analysis', 'still-check']);
  });
});
