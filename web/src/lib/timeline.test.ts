import { describe, expect, it } from 'vitest';
import { dayRange, hourGroups, minuteOf, splitRange, stillIndex, tileIndex, tileStyle, timelineCursor, cursorSearch, type PreviewMinute } from './timeline';

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

// Final review I1: the fall-back day is 25 h, over the one-day limit of
// cam-proxy's list routes, so it is asked in parts.
describe('splitRange', () => {
  it('keeps a normal day whole and splits the 25-hour day', () => {
    const [a, b] = dayRange('2026-09-27');
    expect(splitRange(a, b)).toEqual([[a, b]]);
    const [c, d] = dayRange('2026-11-01');
    const parts = splitRange(c, d);
    expect(parts.length).toBe(2);
    expect(parts[0][0]).toBe(c);
    expect(parts[1][1]).toBe(d);
    expect(parts[1][0]).toBe(parts[0][1] + 1);
    for (const [x, y] of parts) expect(y - x).toBeLessThanOrEqual(86_400_000);
  });
});

// Final review I6: stepping back lands on the previous second.
describe('stillIndex', () => {
  const stills = [1000, 2000, 3000];
  it('finds the first still at or after a time going forward, the last at or before going back', () => {
    expect(stillIndex(stills, 1500, 1)).toBe(1);
    expect(stillIndex(stills, 59_999, -1)).toBe(2);
    expect(stillIndex(stills, 2000, -1)).toBe(1);
    expect(stillIndex(stills, 5000, 1)).toBe(2);
    expect(stillIndex(stills, 0, -1)).toBe(0);
  });
});

// Final review I7: the view can be reloaded and linked (?cam&date&t).
describe('timeline cursor', () => {
  it('reads and writes cam, date and the open still', () => {
    expect(timelineCursor(new URLSearchParams('cam=den&date=2026-09-27&t=1790538436000'), '2026-09-28')).toEqual({ cam: 'den', date: '2026-09-27', t: 1790538436000 });
    expect(timelineCursor(new URLSearchParams('date=bad&t=x'), '2026-09-28')).toEqual({ cam: null, date: '2026-09-28', t: null });
    expect(cursorSearch({ cam: 'den', date: '2026-09-27', t: null })).toBe('?cam=den&date=2026-09-27');
    expect(cursorSearch({ cam: 'den', date: '2026-09-27', t: 5 })).toBe('?cam=den&date=2026-09-27&t=5');
  });
});
