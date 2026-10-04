import { describe, expect, it } from 'vitest';
import { detectionMoments, parseProxyEvents, thumbPlan } from '../server/recordings/detection';

// Issue #157: a card's thumbnail shows the moment the camera's AI saw the
// person, vehicle or pet, not the pre-record before it.
const S = 1_790_000_000_000; // the card's start
const E = S + 60_000; // its end
const ev = (id: number, kind: string, start: number, analysis: unknown = null) => ({ id, kind, source: 'onvif', start, end: start + 5000, endReason: 'state', analysis });
const ok = (stillTs: number, category: string, score: number) => ({ provider: 'google-vision', status: 'ok', reason: null, stillTs, objects: [], summary: [{ category, subtype: category, score, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }] });

describe('detectionMoments', () => {
  it('is the first second a person, vehicle or pet became active in the card', () => {
    const events = parseProxyEvents([ev(4, 'motion', S + 1000), ev(5, 'person', S + 9000), ev(6, 'vehicle', S + 7000)]);
    expect(detectionMoments(events, S, E)).toEqual([S + 7000]);
  });

  // Klaus, 2026-10-04: the still of the card's first Vision-confirmed event,
  // not the highest score (#157 had that).
  it('prefers the analysed still of the first event Vision confirmed the type of', () => {
    const events = parseProxyEvents([
      ev(5, 'person', S + 7000, ok(S + 8000, 'person', 0.62)),
      ev(6, 'person', S + 20_000, ok(S + 21_000, 'person', 0.91)),
      ev(7, 'pet', S + 30_000, ok(S + 31_000, 'person', 0.99)), // not its type
    ]);
    expect(detectionMoments(events, S, E)).toEqual([S + 8000, S + 21_000, S + 7000]);
  });

  it('skips an analysis that found nothing of the type, or failed', () => {
    const events = parseProxyEvents([
      ev(5, 'person', S + 7000, { ...ok(S + 8000, 'person', 0.8), summary: [] }),
      ev(6, 'person', S + 9000, { ...ok(S + 10_000, 'person', 0.8), status: 'error' }),
    ]);
    expect(detectionMoments(events, S, E)).toEqual([S + 7000]);
  });

  it('counts an event from 5 s before the card to its end', () => {
    const events = parseProxyEvents([ev(1, 'person', S - 6000), ev(2, 'pet', E + 1000), ev(3, 'pet', S - 4000)]);
    expect(detectionMoments(events, S, E)).toEqual([S - 4000]);
  });

  it('is empty for motion only, and for anything that isn’t an event list', () => {
    expect(detectionMoments(parseProxyEvents([ev(1, 'motion', S + 1000)]), S, E)).toEqual([]);
    expect(detectionMoments(parseProxyEvents({ error: 'x' }), S, E)).toEqual([]);
    expect(detectionMoments(parseProxyEvents([null, { kind: 'person' }, ev(2, 'person', 1.5)]), S, E)).toEqual([]);
  });
});

// Klaus, 2026-10-04: the thumbnail is the still of the card's first
// Vision-confirmed AI event; with none confirmed, the first AI event's
// detection second. The version names that choice, so it changes when an
// analysis arrives later.
describe('thumbPlan', () => {
  const none = (stillTs: number) => ({ ...ok(stillTs, 'person', 0.5), summary: [] });
  it('the real 05:16:43 card: two person events, neither confirmed → the first one’s second', () => {
    const events = parseProxyEvents([ev(928, 'person', S + 36_000, none(S + 37_000)), ev(930, 'person', S + 45_000, none(S + 46_000))]);
    expect(thumbPlan(events)).toEqual({ version: 'd928', moments: [S + 36_000] });
  });
  it('switches to a later event’s analysed still once Vision confirms it', () => {
    const events = parseProxyEvents([ev(928, 'person', S + 36_000, none(S + 37_000)), ev(930, 'person', S + 45_000, ok(S + 46_000, 'person', 0.7))]);
    expect(thumbPlan(events)).toEqual({ version: 'c930', moments: [S + 46_000, S + 36_000] });
  });
  it('takes the first confirmed event, not the best score', () => {
    const events = parseProxyEvents([ev(1, 'vehicle', S + 5000, ok(S + 6000, 'vehicle', 0.6)), ev(2, 'vehicle', S + 9000, ok(S + 10_000, 'vehicle', 0.95))]);
    expect(thumbPlan(events)).toEqual({ version: 'c1', moments: [S + 6000, S + 10_000, S + 5000] });
  });
  it('is null without AI events (a motion card)', () => {
    expect(thumbPlan([])).toBeNull();
  });
});
