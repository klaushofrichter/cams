import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { getAiEventStore, resetAiEventStore } from '../server/proxy/aiEvents';
import { resetAnalysisStore } from '../server/proxy/analyses';
import { proxyHub } from '../server/proxy/stream';
import { cardEvents, kindCounts, parseProxyEvents } from '../server/recordings/detection';
import { getRecordings, type EventClip } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeEvent, type FakeProxy } from './proxy/fakeProxy';

// Klaus, 2026-10-04: a card holding several events of one AI type says so,
// "Person 2x" (Vehicle, Pet likewise); Motion never gets a count. The real
// case: the 05:16:43 card (103 s) held person events at 05:17:19 and 05:17:28.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const S = Date.parse('2026-10-04T05:16:43-05:00');
const card = (from: string, to: string, durationSec: number, triggers: EventClip['triggers']): EventClip => ({
  id: `20261004-${from.replaceAll(':', '')}-${to.replaceAll(':', '')}`,
  start: `2026-10-04T${from}-05:00`,
  end: `2026-10-04T${to}-05:00`,
  durationSec,
  triggers,
  sizeSub: 1,
  sizeMain: 1,
});
const event = (id: number, kind: string, start: number, analysis: unknown = null): FakeEvent => ({ id, kind, source: 'onvif', start, end: start + 2000, endReason: 'state', analysis });

describe('cardEvents and kindCounts', () => {
  const cards = [{ start: S, end: S + 103_000 }, { start: S + 134_000, end: S + 163_000 }];
  it('gives each AI event to its card and counts them per type', () => {
    const events = parseProxyEvents([event(928, 'person', S + 36_000), event(930, 'person', S + 45_000), event(931, 'pet', S + 140_000), event(932, 'motion', S + 50_000)]);
    const per = cardEvents(cards, events);
    expect(per.map((l) => l.map((e) => e.id))).toEqual([[928, 930], [931]]);
    expect(kindCounts(per[0])).toEqual({ person: 2 });
    expect(kindCounts(per[1])).toEqual({ pet: 1 });
  });
  it('counts an event once even where two cards overlap (the later one that had started)', () => {
    const overlapping = [{ start: S, end: S + 30_000 }, { start: S + 28_000, end: S + 60_000 }];
    const per = cardEvents(overlapping, parseProxyEvents([event(1, 'vehicle', S + 29_000)]));
    expect(per.map((l) => l.length)).toEqual([0, 1]);
  });
});

describe('GET /api/cameras/:id/events: per-type counts', () => {
  let fake: FakeProxy;
  const person = card('05:16:43', '05:18:26', 103, ['person', 'motion']);
  const motion = card('05:18:57', '05:19:26', 29, ['motion']);
  beforeEach(async () => {
    fake = await startFakeProxy();
    setCameras([
      { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
      { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
    ]);
    resetProxyClients();
    resetAnalysisStore();
    resetAiEventStore();
    vi.spyOn(getRecordings(), 'events').mockResolvedValue([person, motion]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.stop();
    setCameras([]);
  });
  const get = (cam = 'den') => request(createApp()).get(`/api/cameras/${cam}/events?date=2026-10-04`).set('Cookie', auth);
  type Card = EventClip & { counts?: Record<string, number> };

  it('counts the person events of the 05:16:43 card, none for motion', async () => {
    fake.events.set('cam1', [event(927, 'motion', S + 33_000), event(928, 'person', S + 36_000), event(929, 'motion', S + 37_000), event(930, 'person', S + 45_000), event(935, 'motion', S + 140_000)]);
    const cards = (await get()).body.events as Card[];
    expect(cards[0].counts).toEqual({ person: 2 });
    expect(cards[1].counts).toBeUndefined();
    // Only the AI kinds are asked for (a busy day has thousands of motion events).
    const kinds = fake.requests.filter((q) => q.path === '/api/cameras/cam1/events').map((q) => q.query.kind);
    expect(kinds.sort()).toEqual(['person', 'pet', 'vehicle']);
  });

  it('has no counts when the proxy’s events can’t be read, and for a camera without a proxy', async () => {
    fake.eventsStatus = 500;
    expect(((await get()).body.events as Card[]).every((c) => c.counts === undefined)).toBe(true);
    expect(((await get('shed')).body.events as Card[]).every((c) => c.counts === undefined)).toBe(true);
  });

  it('asks again after a camera event or an analysis for the camera arrives', async () => {
    fake.events.set('cam1', [event(928, 'person', S + 36_000)]);
    expect(((await get()).body.events as Card[])[0].counts).toEqual({ person: 1 });
    fake.events.get('cam1')!.push(event(930, 'person', S + 45_000));
    expect(((await get()).body.events as Card[])[0].counts).toEqual({ person: 1 }); // cached
    proxyHub.emit('message', { cam: 'den', type: 'camera-event', data: { kind: 'person', phase: 'start', ts: S + 45_000 } });
    expect(((await get()).body.events as Card[])[0].counts).toEqual({ person: 2 });
    expect(getAiEventStore()).toBeDefined();
  });
});
