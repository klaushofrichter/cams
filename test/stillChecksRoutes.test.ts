import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetRateLimits } from '../server/middleware/rateLimit';
import { resetProxyClients } from '../server/proxy/client';
import { resetAnalysisStore } from '../server/proxy/analyses';
import { getCheckStore, parseCheck, parseUsage, resetCheckStore } from '../server/proxy/stillChecks';
import { proxyHub } from '../server/proxy/stream';
import { attachAnalyses, cardHolding } from '../server/recordings/analysis';
import { getRecordings, type EventClip } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeAnalysis, type FakeProxy } from './proxy/fakeProxy';

// Still checks through cams (cams #179, spec 2026-10-04-still-checks-ui-design),
// against the fake cam-proxy implementing cam-proxy's still checks contract.

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
const person = { category: 'person', subtype: 'person', score: 0.84, box };
const AT = Math.floor(Date.now() / 60_000) * 60_000 - 120_000; // a recent second with a still
let fake: FakeProxy;

beforeEach(async () => {
  fake = await startFakeProxy();
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
  resetAnalysisStore();
  resetCheckStore();
  resetRateLimits();
  fake.stills.set('cam1', new Map([[AT, JPEG], [AT + 1000, JPEG]]));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.stop();
  setCameras([]);
});

const app = () => createApp();
const get = (path: string) => request(app()).get(path).set('Cookie', auth);
const post = (body: unknown, cam = 'den') => request(app()).post(`/api/cameras/${cam}/still-checks`).set('Cookie', auth).send(body as object);

describe('POST /api/cameras/:id/still-checks', () => {
  it('checks a second: 201, the parsed check, cams’s image URL, never raw', async () => {
    fake.checkAnswers.set(`cam1|${AT}`, { summary: [person], objects: [{ mid: '/m/01g317', name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.6, box }] });
    const r = await post({ at: AT });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      reused: false,
      check: {
        id: 1, eventId: null, stillTs: AT, provider: 'google-vision', summary: [person], events: [], imageUrl: '/api/cameras/den/still-checks/1.jpg',
        objects: [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.6, box }], requestedAt: expect.any(Number), tookMs: 597,
      },
    });
    expect(fake.requests.find((x) => x.path === '/api/cameras/cam1/still-checks')?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('says a stored answer is reused, from a check or from an event’s analysis', async () => {
    await post({ at: AT });
    const again = await post({ at: AT });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, source: 'check', check: { id: 1, stillTs: AT } });
    const a: FakeAnalysis = { eventId: 9, kind: 'person', start: AT, end: AT + 5000, provider: 'google-vision', status: 'ok', reason: null, stillTs: AT + 1000, summary: [person as FakeAnalysis['summary'][0]], objects: [] };
    fake.analyses.set('cam1', [a]);
    const ev = await post({ at: AT + 1000 });
    expect(ev.status).toBe(200);
    expect(ev.body).toMatchObject({ reused: true, source: 'event', check: { id: null, eventId: 9, imageUrl: null } });
    expect(fake.checkCalls).toBe(1);
  });

  it('refuses a bad second before asking the proxy', async () => {
    for (const [body, detail] of [
      [{}, 'at is a whole number (unix ms)'],
      [{ at: '1000' }, 'at is a whole number (unix ms)'],
      [{ at: AT + 500 }, 'at is a whole second'],
      [{ at: Date.now() + 60_000 - (Date.now() % 1000) }, 'at is in the future'],
    ] as const) {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid', detail });
    }
    expect(fake.requests.some((x) => x.path.includes('still-checks'))).toBe(false);
  });

  it('passes the proxy’s refusals on with their reason', async () => {
    fake.analytics.checks.today = 10;
    expect((await post({ at: AT })).body).toEqual({ error: 'limit', reason: 'checks' });
    fake.analytics.paused = { reason: 'quota', until: 1791134400000 };
    let r = await post({ at: AT });
    expect([r.status, r.body]).toEqual([503, { error: 'analytics_paused', reason: 'quota', until: 1791134400000 }]);
    fake.analytics.noKey = true;
    r = await post({ at: AT });
    expect([r.status, r.body]).toEqual([409, { error: 'analytics_off', reason: 'no_key' }]);
    fake.analytics.noKey = false;
    fake.analytics.paused = null;
    fake.analytics.checks.today = 0;
    fake.checkFailure = { status: 502, body: { error: 'provider_failed', reason: 'timeout', secret: 'x' } };
    r = await post({ at: AT });
    expect([r.status, r.body]).toEqual([502, { error: 'provider_failed', reason: 'timeout' }]);
    r = await post({ at: AT + 2000 });
    expect([r.status, r.body]).toEqual([404, { error: 'no_still' }]);
  });

  it('calls an older proxy “too old”, and an unreachable one unavailable', async () => {
    fake.analyticsStatus = 404;
    expect((await post({ at: AT })).body).toEqual({ error: 'too_old' });
    fake.offline = true;
    const r = await post({ at: AT });
    expect([r.status, r.body]).toEqual([502, { error: 'proxy_unavailable' }]);
  });

  it('is for cameras with a proxy, and same-origin only', async () => {
    expect((await post({ at: AT }, 'shed')).body).toEqual({ error: 'no_proxy' });
    const r = await request(app()).post('/api/cameras/den/still-checks').set('Cookie', auth).set('Origin', 'https://evil.example').send({ at: AT });
    expect(r.status).toBe(403);
    const anon = await request(app()).post('/api/cameras/den/still-checks').send({ at: AT });
    expect(anon.status).toBe(401);
  });

  describe('per-user limits', () => {
    const OTHER = 'someone@example.com';
    const as = (email: string) => request(app()).post('/api/cameras/den/still-checks').set('Cookie', `${SESSION_COOKIE}=${signSession(email)}`).send({ at: AT });
    let emails: string | undefined;
    beforeEach(() => {
      emails = process.env.ALLOWED_EMAILS;
      process.env.ALLOWED_EMAILS = `klaus@klaushofrichter.net,${OTHER}`;
    });
    afterEach(() => {
      process.env.ALLOWED_EMAILS = emails;
      delete process.env.RATE_LIMIT_CHECKS_PER_MIN;
    });

    it('6 a minute for each user, each with a bucket of their own', async () => {
      for (let i = 0; i < 6; i++) expect((await post({ at: AT })).status).not.toBe(429);
      const r = await post({ at: AT });
      expect([r.status, r.body]).toEqual([429, { error: 'rate_limited' }]);
      for (let i = 0; i < 6; i++) expect((await as(OTHER)).status).not.toBe(429);
      expect((await as(OTHER)).status).toBe(429);
    });

    it('60 a day: the 61st is refused', async () => {
      process.env.RATE_LIMIT_CHECKS_PER_MIN = '1000'; // only the day's limit counts here
      for (let i = 0; i < 60; i++) expect((await post({ at: AT })).status).not.toBe(429);
      const r = await post({ at: AT });
      expect([r.status, r.body]).toEqual([429, { error: 'rate_limited' }]);
      expect((await as(OTHER)).status).not.toBe(429);
    });
  });
});

describe('GET still checks, one, its image, the usage', () => {
  it('lists a range, parsed, with cams’s image URLs', async () => {
    await post({ at: AT });
    const r = await get(`/api/cameras/den/still-checks?from=${AT - 1000}&to=${AT + 1000}`);
    expect(r.body).toEqual([{ id: 1, eventId: null, stillTs: AT, provider: 'google-vision', summary: [], events: [], imageUrl: '/api/cameras/den/still-checks/1.jpg' }]);
    expect((await get('/api/cameras/den/still-checks?from=5&to=1')).status).toBe(400);
    expect((await get(`/api/cameras/den/still-checks?from=0&to=${32 * 86_400_000}`)).body.detail).toBe('at most 31 days per request');
  });

  it('answers an empty list from an older proxy', async () => {
    fake.analyticsStatus = 404;
    expect((await get(`/api/cameras/den/still-checks?from=0&to=1000`)).body).toEqual([]);
  });

  it('gives one check’s objects without raw, and its image', async () => {
    await post({ at: AT });
    const r = await get('/api/cameras/den/still-checks/1');
    expect(r.status).toBe(200);
    expect(r.body.objects).toEqual([{ name: 'Ceiling fan', score: 0.6, box: { x0: 0, y0: 0, x1: 0.2, y1: 0.2 } }]);
    expect(r.body).not.toHaveProperty('raw');
    const img = await get('/api/cameras/den/still-checks/1.jpg');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(img.body as Buffer, JPEG)).toBe(0);
    expect((await get('/api/cameras/den/still-checks/9')).status).toBe(404);
    expect((await get('/api/cameras/den/still-checks/9.jpg')).status).toBe(404);
    expect((await get('/api/cameras/den/still-checks/..%2Fx')).status).toBe(400);
  });

  it('relays the usage, never more than the contract names', async () => {
    const r = await get('/api/cameras/den/analytics');
    expect(r.body).toEqual({ enabled: true, paused: null, month: { calls: 14, limit: 1000 }, today: { calls: 2, cap: 30 }, checks: { today: 0, cap: 10 } });
    fake.analyticsStatus = 404;
    const old = await get('/api/cameras/den/analytics');
    expect([old.status, old.body]).toEqual([404, { error: 'too_old' }]);
  });

  it('parses odd answers safely', () => {
    expect(parseUsage({ enabled: 'yes', paused: { reason: 'bad_key' }, month: { calls: -1 }, key: 'AIza' })).toEqual({
      enabled: false, paused: { reason: 'bad_key', until: null }, month: { calls: 0, limit: 0 }, today: { calls: 0, cap: 0 }, checks: { today: 0, cap: 0 },
    });
    expect(parseCheck({ id: 'x', stillTs: 1 })).toBeNull();
    expect(parseCheck({ id: 3, stillTs: 1000, events: [{ id: 1, kind: 'person', confirmed: true }, { id: 'x' }], imageUrl: 'http://elsewhere/x.jpg' })).toEqual({
      id: 3, eventId: null, stillTs: 1000, provider: 'unknown', summary: [], events: [{ id: 1, kind: 'person', confirmed: true }], image: true,
    });
  });
});

describe('checks on the cards (confirm only)', () => {
  const T = Date.parse('2026-09-30T15:48:20-05:00');
  const iso = (ms: number) => new Date(ms - 5 * 3_600_000).toISOString().replace('.000Z', '-05:00');
  const card = (triggers: string[], s = T, e = T + 20_000) => ({ id: 'c', start: iso(s), end: iso(e), triggers });
  const check = (summary: unknown[], stillTs = T + 5000, id: number | null = 3) => ({ id, eventId: null, stillTs, provider: 'google-vision', summary: summary as never, events: [], image: true });
  const pet = { category: 'pet' as const, subtype: 'dog', score: 0.7, box };
  const pers = { ...person, category: 'person' as const };

  it('confirms the card’s label it found, like an analysis, and joins its stills', () => {
    const [c] = attachAnalyses([card(['person'])], [], [check([pers])]);
    expect(c.analysis).toEqual({ best: { person: { score: 0.84, subtype: 'person' } }, notConfirmed: [], stills: [{ eventId: 0, kind: 'check', stillTs: T + 5000, summary: [pers], checkId: 3 }] });
  });

  it('turns an automatic “not confirmed” into a confirmation', () => {
    const auto = { eventId: 1, kind: 'person', start: T, end: T + 5000, status: 'ok', reason: null, stillTs: T + 1000, summary: [] };
    const [c] = attachAnalyses([card(['person'])], [auto], [check([pers])]);
    expect(c.analysis?.notConfirmed).toEqual([]);
    expect(c.analysis?.best.person?.score).toBe(0.84);
    const [plain] = attachAnalyses([card(['person'])], [auto], []);
    expect(plain.analysis?.notConfirmed).toEqual(['person']);
  });

  it('never adds another category, never “not confirmed”, and leaves an unanalysed card alone when it confirms nothing', () => {
    const [c] = attachAnalyses([card(['person'])], [], [check([pet])]);
    expect(c.analysis).toBeUndefined();
    const [m] = attachAnalyses([card(['motion'])], [], [check([])]);
    expect(m.analysis).toBeUndefined();
  });

  it('of two overlapping cards, confirms the latest that had started (a clip repeating the last one’s end)', () => {
    const first = card(['person'], T, T + 20_000);
    const second = { ...card(['person'], T + 16_000, T + 40_000), id: 'd' };
    const [a, b] = attachAnalyses([first, second], [], [check([pers], T + 18_000)]);
    expect(a.analysis).toBeUndefined();
    expect(b.analysis?.best.person?.score).toBe(0.84);
    const [c, d] = attachAnalyses([first, second], [], [check([pers], T + 10_000)]);
    expect(c.analysis?.best.person?.score).toBe(0.84);
    expect(d.analysis).toBeUndefined();
    expect(cardHolding([{ s: 0, e: 10 }, { s: 5, e: 20 }, { s: 2, e: 30 }], 7)).toBe(1);
  });

  it('belongs to the card whose span holds its second, without slack; reused answers (no id) are not checks', () => {
    expect(attachAnalyses([card(['person'])], [], [check([pers], T - 1000)])[0].analysis).toBeUndefined();
    expect(attachAnalyses([card(['person'])], [], [check([pers], T + 5000, null)])[0].analysis).toBeUndefined();
  });

  it('reach the cards through GET /events, and a still-check message drops the cached day', async () => {
    const day = '2026-09-30';
    const c: EventClip = { id: '20260930154820', start: iso(T), end: iso(T + 20_000), durationSec: 20, triggers: ['person'], sizeSub: 1, sizeMain: 1 };
    vi.spyOn(getRecordings(), 'events').mockResolvedValue([c]);
    vi.spyOn(Date, 'now').mockReturnValue(T + 86_400_000 * 2);
    fake.stills.set('cam1', new Map([[T + 5000, JPEG]]));
    const r1 = await get(`/api/cameras/den/events?date=${day}`);
    expect(r1.body.events[0]).not.toHaveProperty('analysis');
    fake.checks.set('cam1', [{ id: 4, stillTs: T + 5000, provider: 'google-vision', summary: [person], objects: [], requestedAt: T, tookMs: 1, image: JPEG }]);
    expect((await get(`/api/cameras/den/events?date=${day}`)).body.events[0]).not.toHaveProperty('analysis'); // cached
    proxyHub.emit('message', { cam: 'den', type: 'still-check', data: {} });
    const r2 = await get(`/api/cameras/den/events?date=${day}`);
    expect(r2.body.events[0].analysis.best).toEqual({ person: { score: 0.84, subtype: 'person' } });
    expect(await getCheckStore().forDay('den', day, [])).toEqual([]);
  });
});
