import { afterEach, describe, expect, it, vi } from 'vitest';
import { chicagoMs, motionStillMs, outsideDemoClips, personDetectionMs, secondPersonMs, vehicleDetectionMs } from '../e2e/fakeProxyData';

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
    expect(chicago(personDetectionMs())).toBe(`${date}T08:15:14`);
    expect(chicago(secondPersonMs())).toBe(`${date}T08:15:24`);
  });

  it('turns a Chicago wall-clock time into the instant, in both offsets', () => {
    expect(new Date(chicagoMs('2026-10-03', '12:05:07')).toISOString()).toBe('2026-10-03T17:05:07.000Z');
    expect(new Date(chicagoMs('2026-12-15', '12:05:07')).toISOString()).toBe('2026-12-15T18:05:07.000Z');
  });

  // Issue #213: "a few minutes ago, stills" must not land on a demo recording.
  describe('outsideDemoClips', () => {
    const now = chicagoMs('2026-10-05', '12:10:20');
    it('keeps a second away from every demo recording', () => {
      const t = chicagoMs('2026-10-05', '12:04:00');
      expect(outsideDemoClips(t, 1000, now)).toBe(t);
    });
    it('moves a second inside today\'s 12:05:05 recording to 5 s before it, or more', () => {
      expect(chicago(outsideDemoClips(chicagoMs('2026-10-05', '12:05:20'), 1000, now))).toBe('2026-10-05T12:04:59');
      expect(chicago(outsideDemoClips(chicagoMs('2026-10-05', '12:05:33'), 1000, now))).toBe('2026-10-05T12:04:59');
    });
    it('steps by whole minutes when asked', () => {
      expect(chicago(outsideDemoClips(chicagoMs('2026-10-05', '12:05:20'), 60_000, now))).toBe('2026-10-05T12:04:20');
    });
    it('knows yesterday\'s recordings too (22:15:10 to 22:15:40)', () => {
      const late = chicagoMs('2026-10-05', '00:05:00');
      expect(chicago(outsideDemoClips(chicagoMs('2026-10-04', '22:15:30'), 1000, late))).toBe('2026-10-04T22:15:04');
    });
  });
});
