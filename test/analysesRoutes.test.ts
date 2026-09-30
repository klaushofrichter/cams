import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { resetAnalysisStore } from '../server/proxy/analyses';
import { getRecordings, type EventClip } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeAnalysis, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const T = Date.parse('2026-09-30T15:48:20-05:00');
const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
const analysis = (o: Partial<FakeAnalysis> = {}): FakeAnalysis => ({
  eventId: 7, kind: 'person', start: T, end: T + 5000, provider: 'google-vision', status: 'ok', reason: null, stillTs: T + 1000,
  summary: [{ category: 'person', subtype: 'person', score: 0.84, box }],
  objects: [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box }],
  ...o,
});
const card: EventClip = { id: '20260930154824', start: '2026-09-30T15:48:24-05:00', end: '2026-09-30T15:48:40-05:00', durationSec: 16, triggers: ['person'], sizeSub: 1, sizeMain: 1 };
let fake: FakeProxy;

beforeEach(async () => {
  fake = await startFakeProxy();
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
  resetAnalysisStore();
  vi.spyOn(getRecordings(), 'events').mockResolvedValue([card]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.stop();
  setCameras([]);
});

const get = (path: string) => request(createApp()).get(path).set('Cookie', auth);

describe('analyses on the events', () => {
  it('attach to the cards of a camera with a proxy', async () => {
    fake.analyses.set('cam1', [analysis()]);
    const r = await get('/api/cameras/den/events?date=2026-09-30');
    expect(r.status).toBe(200);
    expect(r.body.events[0].analysis).toEqual({
      best: { person: { score: 0.84, subtype: 'person' } },
      notConfirmed: [],
      stills: [{ eventId: 7, stillTs: T + 1000, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }] }],
    });
  });

  it('leave the cards as they are when the proxy fails', async () => {
    fake.analysesStatus = 500;
    const r = await get('/api/cameras/den/events?date=2026-09-30');
    expect(r.status).toBe(200);
    expect(r.body.events[0]).not.toHaveProperty('analysis');
  });

  it('never hold the events back: a stalled proxy answers within the fetch timeout, without analysis', async () => {
    resetAnalysisStore({ timeoutMs: 300 });
    fake.analysesStall = true;
    const t0 = Date.now();
    const r = await get('/api/cameras/den/events?date=2026-09-30');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.status).toBe(200);
    expect(r.body.events[0]).not.toHaveProperty('analysis');
  });

  it('are not asked for a camera without a proxy', async () => {
    const r = await get('/api/cameras/shed/events?date=2026-09-30');
    expect(r.status).toBe(200);
    expect(r.body.events[0]).not.toHaveProperty('analysis');
    expect(fake.requests.some((x) => x.path.endsWith('/analyses'))).toBe(false);
  });
});

describe('GET /api/cameras/:id/analyses/:eventId', () => {
  it('needs a signed-in user', async () => {
    expect((await request(createApp()).get('/api/cameras/den/analyses/7')).status).toBe(401);
  });

  it('answers one analysis in full, without the raw answer', async () => {
    fake.analyses.set('cam1', [analysis()]);
    const r = await get('/api/cameras/den/analyses/7');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      eventId: 7, status: 'ok', stillTs: T + 1000,
      summary: [{ category: 'person', subtype: 'person', score: 0.84, box }],
      objects: [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box }],
    });
    expect(JSON.stringify(r.body)).not.toContain('raw');
    expect(fake.requests.at(-1)?.path).toBe('/api/cameras/cam1/events/7/analysis');
  });

  it('says not found, refuses a bad id, and needs a proxy', async () => {
    expect((await get('/api/cameras/den/analyses/8')).status).toBe(404);
    expect((await get('/api/cameras/den/analyses/x')).status).toBe(400);
    expect((await get('/api/cameras/shed/analyses/7')).body).toEqual({ error: 'no_proxy' });
  });
});
