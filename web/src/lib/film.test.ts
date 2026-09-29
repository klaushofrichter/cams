import { describe, expect, it } from 'vitest';
import { filmFrames, FILM_W, FILM_GAP } from './film';
import type { PreviewMinute } from './timeline';

// The band of small frames under the strip (Klaus, 2026-09-28).
const T0 = Date.parse('2026-09-28T12:00:00-05:00');
const minute = (m: number, present = (i: number) => true): PreviewMinute => ({
  minute: m, url: `/p/${m}.jpg`, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1,
  present: Array.from({ length: 60 }, (_, i) => present(i)),
});

describe('filmFrames', () => {
  it('is half the event-list thumbnail, with a small gap', () => {
    expect(FILM_W).toBe(48);
    expect(FILM_GAP).toBe(4); // a visible gap, 4 px (Klaus, 2026-09-28)
  });

  it('fits as many frames as the width holds, evenly spaced on a grid that moves with time', () => {
    const win = { start: T0 - 1_800_000, end: T0 + 1_800_000 }; // 1 h
    const f = filmFrames(win, 765, []);
    expect(f.length).toBe(14); // 765 px / (48 + 4)
    const step = 3_600_000 / 14;
    expect(f[1].t - f[0].t).toBeCloseTo(step);
    const k = (x: { t: number }) => (x.t - step / 2) / step;
    expect(f.every((x) => Math.abs(k(x) - Math.round(k(x))) < 1e-6)).toBe(true); // a fixed grid: frames slide, not jump
    expect(f.every((x) => x.t >= win.start && x.t < win.end)).toBe(true);
    expect(f[0].left).toBeCloseTo(((f[0].t - win.start) / 3_600_000) * 100);
  });

  it('shows the preview tile at that moment, a neighbouring one if that tile is missing, else none', () => {
    const win = { start: T0, end: T0 + 600_000 };
    const m = Math.floor(T0 / 60_000) * 60_000;
    const previews = [minute(m, (i) => i % 7 !== 3), minute(m + 60_000, () => false)];
    const f = filmFrames(win, 112, previews); // 2 frames: 2.5 and 7.5 min in
    expect(f.length).toBe(2);
    expect(f[0].tile).toBeNull(); // minute 2 has no previews loaded
    const g = filmFrames({ start: m, end: m + 60_000 }, 52 * 20, previews); // 20 frames in the first minute, 3 s apart
    expect(g.filter((x) => x.tile).length).toBe(20); // missing tiles fall back to a neighbour
  });

  it('draws nothing without width', () => {
    expect(filmFrames({ start: T0, end: T0 + 3_600_000 }, 0, [])).toEqual([]);
  });
});
