import { afterEach, describe, expect, it, vi } from 'vitest';
import { chicagoMs, motionStillMs, vehicleDetectionMs } from '../e2e/fakeProxyData';

// The e2e fake proxy's seeded stills for Den's demo recordings (issue #157)
// must fall on today's cards in America/Chicago, the cameras' and the
// browser's zone, at any time of day the suite runs.
const chicago = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(ms)
    .replace(', ', 'T');

afterEach(() => {
  vi.useRealTimers();
});

describe('e2e fixture times', () => {
  // [the pinned clock (UTC), Chicago's date at that moment]
  const clocks: [string, string][] = [
    ['2026-10-04T00:30:00Z', '2026-10-03'], // just after midnight UTC: 19:30 CDT, still the 3rd in Chicago
    ['2026-10-04T05:00:30Z', '2026-10-04'], // just after midnight Chicago (CDT)
    ['2026-10-03T14:00:00Z', '2026-10-03'], // mid-day
    ['2026-10-04T04:59:59Z', '2026-10-03'], // the last second of Chicago's day
    ['2026-12-15T06:00:30Z', '2026-12-15'], // just after midnight Chicago in winter (CST)
    ['2026-11-01T12:00:00Z', '2026-11-01'], // the day DST ends
    ['2026-03-08T12:00:00Z', '2026-03-08'], // the day DST starts
  ];
  it.each(clocks)('at %s the seeded stills are on Chicago’s %s at 09:30:06 and 12:05:07', (now, date) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    expect(chicago(vehicleDetectionMs())).toBe(`${date}T09:30:06`);
    expect(chicago(motionStillMs())).toBe(`${date}T12:05:07`);
  });

  it('turns a Chicago wall-clock time into the instant, in both offsets', () => {
    expect(new Date(chicagoMs('2026-10-03', '12:05:07')).toISOString()).toBe('2026-10-03T17:05:07.000Z');
    expect(new Date(chicagoMs('2026-12-15', '12:05:07')).toISOString()).toBe('2026-12-15T18:05:07.000Z');
  });
});
