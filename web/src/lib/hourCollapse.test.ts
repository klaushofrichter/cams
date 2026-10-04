import { describe, expect, it } from 'vitest';
import { FAR_MS, hourDistance, hourOpenAtLanding, isViewedHour } from './hourCollapse';
import { COLLAPSE_OVER, type EventClip, type HourGroup } from './recordings';

// Tests run with TZ=America/Chicago (vitest.config.mts).
const DATE = '2026-10-04';
const at = (hh: number, mm = 0) => new Date(2026, 9, 4, hh, mm).getTime();
const ev = (id: string): EventClip => ({ id, start: '', end: '', durationSec: 5, triggers: ['motion'], sizeSub: 1, sizeMain: 1 });
const group = (hour: number, n = 1): HourGroup => ({ hour, label: '', events: Array.from({ length: n }, (_, i) => ev(`${hour}-${i}`)) });

describe('hourDistance', () => {
  it('is 0 inside the hour, else the way to its nearer edge', () => {
    expect(hourDistance(DATE, 12, at(12, 30))).toBe(0);
    expect(hourDistance(DATE, 18, at(12, 30))).toBe(5.5 * 3_600_000);
    expect(hourDistance(DATE, 6, at(12, 30))).toBe(5.5 * 3_600_000);
    expect(hourDistance(DATE, 5, at(12, 30))).toBe(6.5 * 3_600_000);
  });
  it('the end of an hour belongs to the next one', () => {
    expect(isViewedHour(DATE, 14, at(15))).toBe(false);
    expect(isViewedHour(DATE, 15, at(15))).toBe(true);
    expect(hourOpenAtLanding(group(14), DATE, at(15), null, false)).toBe(false);
  });
  it('a viewed time on another day is far from every hour', () => {
    expect(hourDistance(DATE, 23, at(12) + 86_400_000)).toBeGreaterThan(FAR_MS);
  });
});

// Stage 2 (spec 2026-10-04): on landing, hours more than 6 h from the viewed
// time collapse; the viewed hour is always open; the user's own toggles win.
describe('hourOpenAtLanding', () => {
  const v = at(12, 30);
  it('collapses hours more than 6 h away, keeps the near ones open', () => {
    expect(hourOpenAtLanding(group(19), DATE, v, null)).toBe(false);
    expect(hourOpenAtLanding(group(18), DATE, v, null)).toBe(true);
    expect(hourOpenAtLanding(group(6), DATE, v, null)).toBe(true);
    expect(hourOpenAtLanding(group(5), DATE, v, null)).toBe(false);
  });
  it('opens the viewed hour, even a busy one or one closed by hand', () => {
    expect(hourOpenAtLanding(group(12, COLLAPSE_OVER + 5), DATE, v, null)).toBe(true);
    expect(hourOpenAtLanding(group(12), DATE, v, null, false)).toBe(true);
  });
  it('keeps what the user chose by hand for the other hours', () => {
    expect(hourOpenAtLanding(group(19), DATE, v, null, true)).toBe(true);
    expect(hourOpenAtLanding(group(13), DATE, v, null, false)).toBe(false);
  });
  it('keeps a near busy hour collapsed unless it holds the selection, as before', () => {
    const busy = group(14, COLLAPSE_OVER + 1);
    expect(hourOpenAtLanding(busy, DATE, v, null)).toBe(false);
    expect(hourOpenAtLanding(busy, DATE, v, busy.events[3].id)).toBe(true);
  });
  it('a far hour holding the selection opens (the selection must be visible)', () => {
    const far = group(2);
    expect(hourOpenAtLanding(far, DATE, v, far.events[0].id)).toBe(true);
  });
});
