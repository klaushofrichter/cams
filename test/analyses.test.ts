import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { AnalysisStore, dayWindow, getAnalysisStore, parseAnalysis, parseObjects, resetAnalysisStore, type ProxyAnalysis } from '../server/proxy/analyses';
import { proxyHub } from '../server/proxy/stream';
import { attachAnalyses, cardFor } from '../server/recordings/analysis';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const T = Date.parse('2026-09-30T15:48:20-05:00');
const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
const person = (score: number, subtype = 'person') => ({ category: 'person' as const, subtype, score, box });
const a = (o: Partial<ProxyAnalysis> = {}): ProxyAnalysis => ({
  eventId: 1, kind: 'person', start: T, end: T + 5000, status: 'ok', reason: null, stillTs: T + 1000, summary: [person(0.84)], ...o,
});
const card = (start: string, end: string, triggers: string[] = ['person']) => ({ id: start, start, end, durationSec: 0, triggers, sizeSub: null, sizeMain: null });
const iso = (ms: number) => new Date(ms - 5 * 3_600_000).toISOString().replace('.000Z', '-05:00');

describe('parseAnalysis', () => {
  it('keeps the message shape, dropping the objects and bad summary entries', () => {
    const got = parseAnalysis({
      ...a(),
      provider: 'google-vision',
      objects: [{ name: 'Ceiling fan', score: 0.9, box }],
      summary: [person(0.84), { category: 'bird', subtype: 'bird', score: 0.9, box }, { category: 'pet', subtype: 'dog', score: 'x', box }, { category: 'pet', subtype: 'dog', score: 0.5 }],
    });
    expect(got).toEqual(a());
  });

  it('drops entries with a score outside 0..1 and boxes outside 0..1', () => {
    const got = parseAnalysis({
      ...a(),
      summary: [person(0.84), person(1.5), person(-0.1), { ...person(0.5), box: { ...box, x1: 1.2 } }, { ...person(0.6), box: { ...box, y0: -0.2 } }],
    });
    expect(got?.summary).toEqual([person(0.84)]);
    expect(parseObjects([{ name: 'Fan', score: 2, box }, { name: 'Fan', score: 0.5, box: { ...box, x1: 3 } }])).toEqual([{ name: 'Fan', score: 0.5, box: null }]);
  });

  it('refuses an older proxy’s message (no start, no summary)', () => {
    expect(parseAnalysis({ eventId: 1, provider: 'google-vision', status: 'ok', reason: null, objects: [] })).toBeNull();
  });

  it('reads objects, with a null box where the proxy sent none', () => {
    expect(parseObjects([{ name: 'Person', score: 0.8, box }, { name: 'Fan', score: 0.6 }, { name: 3 }])).toEqual([
      { name: 'Person', score: 0.8, box },
      { name: 'Fan', score: 0.6, box: null },
    ]);
  });
});

describe('dayWindow', () => {
  it('is the camera’s day from its offset, 5 s early, one day long', () => {
    const [from, to] = dayWindow('2026-09-30', '2026-09-30T15:48:21-05:00')!;
    expect(from).toBe(Date.parse('2026-09-30T00:00:00-05:00') - 5000);
    expect(to - from).toBe(86_400_000 - 1);
  });

  it('is null for a time without an offset', () => {
    expect(dayWindow('2026-09-30', '2026-09-30T15:48:21')).toBeNull();
  });
});

describe('attachAnalyses', () => {
  const c1 = card(iso(T + 4000), iso(T + 30_000));

  it('attaches an analysis from 5 s before a card to its end, best score per category', () => {
    const [c] = attachAnalyses([c1], [a(), a({ eventId: 2, start: T + 10_000, stillTs: T + 11_000, summary: [person(0.9, 'man')] })]);
    expect(c.analysis).toEqual({
      best: { person: { score: 0.9, subtype: 'man' } },
      notConfirmed: [],
      stills: [
        { eventId: 1, kind: 'person', stillTs: T + 1000, summary: [person(0.84)] },
        { eventId: 2, kind: 'person', stillTs: T + 11_000, summary: [person(0.9, 'man')] },
      ],
    });
  });

  it('leaves out an analysis more than 5 s before the card', () => {
    const [c] = attachAnalyses([c1], [a({ start: T - 2000 })]);
    expect(c.analysis).toBeUndefined();
  });

  it('gives an analysis that fits two cards to the one that had started', () => {
    // A clip repeats the last seconds of the one before (its pre-record).
    const c2 = card(iso(T + 27_000), iso(T + 50_000));
    expect(cardFor([{ s: T + 4000, e: T + 30_000 }, { s: T + 27_000, e: T + 50_000 }], T + 28_000)).toBe(1);
    expect(cardFor([{ s: T + 4000, e: T + 30_000 }, { s: T + 27_000, e: T + 50_000 }], T + 25_000)).toBe(0);
    const [x, y] = attachAnalyses([c1, c2], [a({ start: T + 28_000 })]);
    expect(x.analysis).toBeUndefined();
    expect(y.analysis?.stills).toHaveLength(1);
  });

  it('says "not confirmed" when an analysis of the camera’s kind found nothing of it', () => {
    const [c] = attachAnalyses([card(iso(T), iso(T + 30_000), ['person', 'motion'])], [a({ summary: [] })]);
    expect(c.analysis).toEqual({ best: {}, notConfirmed: ['person'], stills: [{ eventId: 1, kind: 'person', stillTs: T + 1000, summary: [] }] });
  });

  // Issue #113: the dialog for "not confirmed" opens on the still of that kind's analysis.
  it('names the analysed event’s kind on each still', () => {
    const [c] = attachAnalyses([card(iso(T), iso(T + 30_000), ['person', 'motion'])], [a({ kind: 'motion', summary: [] }), a({ eventId: 2, kind: 'person', start: T + 3000, stillTs: T + 4000, summary: [] })]);
    expect(c.analysis?.stills.map((s) => [s.eventId, s.kind])).toEqual([[1, 'motion'], [2, 'person']]);
    expect(c.analysis?.notConfirmed).toEqual(['person']);
  });

  it('does not call a person unconfirmed from an analysis of a motion event', () => {
    const [c] = attachAnalyses([card(iso(T), iso(T + 30_000), ['person', 'motion'])], [a({ kind: 'motion', summary: [] })]);
    expect(c.analysis?.notConfirmed).toEqual([]);
  });

  it('reports an extra finding the camera did not label', () => {
    const [c] = attachAnalyses([card(iso(T), iso(T + 30_000), ['person'])], [a({ summary: [person(0.8), { category: 'pet', subtype: 'dog', score: 0.7, box }] })]);
    expect(c.analysis?.best).toEqual({ person: { score: 0.8, subtype: 'person' }, pet: { score: 0.7, subtype: 'dog' } });
  });

  it('adds nothing when every analysis was skipped or failed', () => {
    const [c] = attachAnalyses([c1], [a({ status: 'skipped', reason: 'limit', stillTs: null, summary: [] }), a({ eventId: 2, status: 'failed', reason: 'timeout' })]);
    expect(c).not.toHaveProperty('analysis');
  });
});

describe('AnalysisStore', () => {
  let fake: FakeProxy;
  const NOW = Date.parse('2026-09-30T16:00:00-05:00');
  const day = [card('2026-09-30T15:48:24-05:00', '2026-09-30T15:48:40-05:00')];
  const asked = () => fake.requests.filter((r) => r.path === '/api/cameras/cam1/analyses').length;

  beforeEach(async () => {
    fake = await startFakeProxy();
    // cams calls it "den"; the proxy knows it as "cam1".
    setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } }]);
    resetProxyClients();
  });
  afterEach(async () => {
    await fake.stop();
    setCameras([]);
  });

  it('fetches the day from the proxy once, under the proxy’s name for the camera', async () => {
    fake.analyses.set('cam1', [{ ...a(), provider: 'google-vision', objects: [] }]);
    const s = new AnalysisStore();
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([a()]);
    await s.forDay('den', '2026-09-30', day, NOW + 30_000);
    expect(asked()).toBe(1);
  });

  it('asks again after 60 s for today, and after an hour for a past day', async () => {
    const s = new AnalysisStore();
    await s.forDay('den', '2026-09-30', day, NOW);
    await s.forDay('den', '2026-09-30', day, NOW + 61_000);
    expect(asked()).toBe(2);
    const past = [card('2026-09-29T10:00:00-05:00', '2026-09-29T10:00:20-05:00')];
    await s.forDay('den', '2026-09-29', past, NOW);
    await s.forDay('den', '2026-09-29', past, NOW + 30 * 60_000);
    expect(asked()).toBe(3);
    await s.forDay('den', '2026-09-29', past, NOW + 61 * 60_000);
    expect(asked()).toBe(4);
  });

  it('overlays received messages on the cached day; a message wins over a record fetched before it', async () => {
    fake.analyses.set('cam1', [{ ...a({ status: 'skipped', reason: 'limit', stillTs: null, summary: [] }), provider: 'google-vision', objects: [] }]);
    const s = new AnalysisStore();
    await s.forDay('den', '2026-09-30', day, NOW);
    s.ingest('den', a(), NOW);
    s.ingest('den', a({ eventId: 2, start: T + 60_000 }), NOW);
    const got = await s.forDay('den', '2026-09-30', day, NOW + 1000);
    expect(got.map((x) => [x.eventId, x.status])).toEqual([[1, 'ok'], [2, 'ok']]);
    expect(asked()).toBe(1);
  });

  it('keeps a record fetched after the message arrived: it knows the end (issue #109)', async () => {
    const s = new AnalysisStore();
    s.ingest('den', a({ end: null }), NOW);
    fake.analyses.set('cam1', [{ ...a(), provider: 'google-vision', objects: [] }]);
    expect((await s.forDay('den', '2026-09-30', day, NOW + 1000)).map((x) => x.end)).toEqual([T + 5000]);
  });

  it('serves an expired day as it was while the proxy fails (issue #109)', async () => {
    fake.analyses.set('cam1', [{ ...a(), provider: 'google-vision', objects: [] }]);
    const s = new AnalysisStore();
    await s.forDay('den', '2026-09-30', day, NOW);
    fake.analysesStatus = 500;
    expect(await s.forDay('den', '2026-09-30', day, NOW + 61_000)).toEqual([a()]);
    expect(await s.forDay('den', '2026-09-30', day, NOW + 70_000)).toEqual([a()]);
    expect(asked()).toBe(2);
  });

  it('asks again after 60 s for a day fetched before its end, even once it is over (issue #109)', async () => {
    const s = new AnalysisStore();
    const lateNight = Date.parse('2026-09-30T23:59:30-05:00');
    await s.forDay('den', '2026-09-30', day, lateNight);
    await s.forDay('den', '2026-09-30', day, lateNight + 61_000);
    expect(asked()).toBe(2);
    await s.forDay('den', '2026-09-30', day, lateNight + 30 * 60_000);
    expect(asked()).toBe(2);
  });

  it('forgets received messages two days after their start (issue #109)', async () => {
    const s = new AnalysisStore();
    s.ingest('den', a(), NOW);
    s.ingest('den', a({ eventId: 2, start: T + 2 * 86_400_000 }), T + 2 * 86_400_000 + 1);
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([]);
  });

  it('keeps the analyses from the stream messages, ignoring other types and an older proxy’s shape (issue #109)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); // the listener ingests at the real clock; the store forgets old ones
    resetAnalysisStore();
    fake.offline = true;
    proxyHub.emit('message', { cam: 'den', type: 'analysis', data: a() });
    proxyHub.emit('message', { cam: 'den', type: 'analysis', data: { eventId: 2, status: 'ok', objects: [] } });
    proxyHub.emit('message', { cam: 'den', type: 'clip', data: a({ eventId: 3 }) });
    try {
      expect(await getAnalysisStore().forDay('den', '2026-09-30', day, NOW)).toEqual([a()]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers with the received messages alone while the proxy is away, and asks again next time', async () => {
    const s = new AnalysisStore();
    s.ingest('den', a(), NOW);
    fake.offline = true;
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([a()]);
    fake.offline = false;
    await s.forDay('den', '2026-09-30', day, NOW + 31_000);
    expect(asked()).toBe(1);
  });

  it('remembers a failure for 30 s: one request for loads within it, another after', async () => {
    fake.analysesStatus = 500;
    const s = new AnalysisStore();
    s.ingest('den', a(), NOW);
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([a()]);
    expect(await s.forDay('den', '2026-09-30', day, NOW + 29_000)).toEqual([a()]);
    expect(asked()).toBe(1);
    fake.analysesStatus = null;
    await s.forDay('den', '2026-09-30', day, NOW + 31_000);
    expect(asked()).toBe(2);
  });

  it('gives up on a stalled body after its timeout, and remembers that as a failure', async () => {
    fake.analysesStall = true;
    const s = new AnalysisStore({ timeoutMs: 300 });
    const t0 = Date.now();
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
    await s.forDay('den', '2026-09-30', day, NOW + 1000);
    expect(asked()).toBe(1);
    // The 30 s count from when it failed, not from when it was asked (issue #109).
    await s.forDay('den', '2026-09-30', day, NOW + 30_100);
    expect(asked()).toBe(1);
  });

  it('remembers an older proxy without /analyses as an empty day', async () => {
    fake.analysesStatus = 404;
    const s = new AnalysisStore();
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([]);
    await s.forDay('den', '2026-09-30', day, NOW + 1000);
    expect(asked()).toBe(1);
  });

  it('makes one request for loads of the same day at once', async () => {
    const s = new AnalysisStore();
    await Promise.all([1, 2, 3].map(() => s.forDay('den', '2026-09-30', day, NOW)));
    expect(asked()).toBe(1);
  });

  it('has nothing for a day without cards', async () => {
    expect(await new AnalysisStore().forDay('den', '2026-09-30', [], NOW)).toEqual([]);
    expect(asked()).toBe(0);
  });
});
