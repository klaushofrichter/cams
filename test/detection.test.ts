import { describe, expect, it } from 'vitest';
import { detectionMoments, parseProxyEvents } from '../server/recordings/detection';

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

  it('prefers the analysed still where Vision confirmed the event’s type, the highest score first', () => {
    const events = parseProxyEvents([
      ev(5, 'person', S + 7000, ok(S + 8000, 'person', 0.62)),
      ev(6, 'person', S + 20_000, ok(S + 21_000, 'person', 0.91)),
      ev(7, 'pet', S + 30_000, ok(S + 31_000, 'person', 0.99)), // not its type
    ]);
    expect(detectionMoments(events, S, E)).toEqual([S + 21_000, S + 8000, S + 7000]);
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
