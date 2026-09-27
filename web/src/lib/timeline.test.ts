import { describe, expect, it } from 'vitest';
import { dayRange, hourGroups, minuteOf, tileIndex, tileStyle, type PreviewMinute } from './timeline';

// Tests run with TZ=America/Chicago (vitest.config).
const m = (minute: number, present = Array(60).fill(true)): PreviewMinute => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present, url: `/x/${minute}.jpg` });

describe('timeline helpers', () => {
  it('turns a local day into a UTC range, 23 and 25 hours on the DST days', () => {
    expect(dayRange('2026-09-27')).toEqual([Date.UTC(2026, 8, 27, 5), Date.UTC(2026, 8, 28, 5) - 1]);
    const [s1, e1] = dayRange('2026-03-08');
    expect(e1 + 1 - s1).toBe(23 * 3_600_000);
    const [s2, e2] = dayRange('2026-11-01');
    expect(e2 + 1 - s2).toBe(25 * 3_600_000);
  });

  it('finds the tile for a second, and its sprite position', () => {
    const x = m(Date.UTC(2026, 8, 27, 19, 3));
    expect(tileIndex(x, x.minute + 12_400)).toBe(12);
    expect(minuteOf(x.minute + 59_999)).toBe(x.minute);
    expect(tileStyle(x, 12, 0.5)).toBe(`background-image:url('/x/${x.minute}.jpg');background-size:800px 270px;background-position:-160px -45px;width:80px;height:45px`);
  });

  it('groups minutes by local hour', () => {
    const h14 = Date.UTC(2026, 8, 27, 19, 0); // 14:00 CDT
    const groups = hourGroups([m(h14), m(h14 + 60_000), m(h14 + 3_600_000)]);
    expect(groups.map((g) => [g.hour, g.minutes.length])).toEqual([[14, 2], [15, 1]]);
  });
});
