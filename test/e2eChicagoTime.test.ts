import { describe, expect, it } from 'vitest';
import { chicagoIso, chicagoMs } from '../e2e/fakeProxyData';

// The e2e specs' Chicago wall-time helpers, at fixed dates on both sides of
// the US changes (they once assumed -05:00, and chicagoMs took the offset of
// its first guess, an hour off for a few hours after falling back).
describe('e2e Chicago time helpers', () => {
  it.each([
    ['2026-10-04', '12:00:00', '2026-10-04T17:00:00Z', '-05:00'], // summer
    ['2026-12-15', '12:00:00', '2026-12-15T18:00:00Z', '-06:00'], // winter
    ['2026-11-01', '00:30:00', '2026-11-01T05:30:00Z', '-05:00'], // the fall-back day, before 01:00
    ['2026-11-01', '02:00:00', '2026-11-01T08:00:00Z', '-06:00'], // after it
    ['2026-11-01', '06:00:00', '2026-11-01T12:00:00Z', '-06:00'], // the first guess (06:00Z) is still daylight time
    ['2026-11-01', '12:30:00', '2026-11-01T18:30:00Z', '-06:00'],
    ['2026-03-08', '01:30:00', '2026-03-08T07:30:00Z', '-06:00'], // the spring day, before 02:00
    ['2026-03-08', '03:00:00', '2026-03-08T08:00:00Z', '-05:00'], // after it
    ['2026-03-08', '05:00:00', '2026-03-08T10:00:00Z', '-05:00'], // the first guess (05:00Z) is still standard time
  ])('%s %s', (date, hms, utc, off) => {
    expect(new Date(chicagoMs(date, hms)).toISOString()).toBe(utc.replace('Z', '.000Z'));
    expect(chicagoIso(date, hms)).toBe(`${date}T${hms}${off}`);
  });
});
