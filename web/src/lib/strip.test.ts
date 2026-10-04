// web/src/lib/strip.test.ts
import { describe, expect, it } from 'vitest';
import {
  STRIP_ZOOMS, normalizeZoom, zoomKey, zoomLabel, clipRuns, clipStartFromId, inRuns, localDaysBetween, mergeRuns, nextChange, previewRuns, sourceAt, stillRuns, stripSpans, windowAround,
  type Coverage,
} from './strip';
import type { EventClip } from './recordings';
import type { PreviewMinute } from './timeline';

// TZ=America/Chicago (vitest config). 2026-09-27 is CDT (-05:00).
const at = (hhmmss: string, day = '2026-09-27') => Date.parse(`${day}T${hhmmss}-05:00`);
const clip = (id: string, s: string, e: string): EventClip => ({
  id, start: new Date(at(s)).toISOString(), end: new Date(at(e)).toISOString(), durationSec: (at(e) - at(s)) / 1000, triggers: ['motion'], sizeSub: 1, sizeMain: 1,
});
const NOW = at('20:00:00');

describe('runs', () => {
  it('merges touching and nearby runs', () => {
    expect(mergeRuns([{ start: 5, end: 8 }, { start: 0, end: 5 }, { start: 20, end: 30 }])).toEqual([{ start: 0, end: 8 }, { start: 20, end: 30 }]);
    expect(mergeRuns([{ start: 0, end: 5 }, { start: 7, end: 9 }], 3)).toEqual([{ start: 0, end: 9 }]);
  });
  it('finds the run containing t, end exclusive', () => {
    const r = [{ start: 0, end: 10 }];
    expect(inRuns(r, 0)).toEqual(r[0]);
    expect(inRuns(r, 10)).toBeNull();
  });
  it('turns still timestamps into runs, bridging gaps under 3 s', () => {
    expect(stillRuns([0, 1000, 2000, 4000, 9000])).toEqual([{ start: 0, end: 5000 }, { start: 9000, end: 10_000 }]);
  });
  it('turns preview minutes into runs of present tiles', () => {
    const m = (minute: number, present: boolean[]): PreviewMinute => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present, url: '' });
    const p = Array(60).fill(true).map((_, i) => i < 30);
    expect(previewRuns([m(60_000, p), m(120_000, Array(60).fill(true))])).toEqual([{ start: 60_000, end: 90_000 }, { start: 120_000, end: 180_000 }]);
  });
  it('builds clip runs, leaving out failed clips', () => {
    const c = clip('20260927-120000-120030', '12:00:00', '12:00:30');
    expect(clipRuns([c])).toEqual([{ start: at('12:00:00'), end: at('12:00:30'), clip: c }]);
    expect(clipRuns([c], new Set([c.id]))).toEqual([]);
  });
});

describe('sourceAt / nextChange', () => {
  const c = clip('20260927-120000-120030', '12:00:00', '12:00:30');
  const cov: Coverage = {
    clips: clipRuns([c]),
    stills: [{ start: at('11:59:00'), end: at('12:05:00') }],
    previews: [{ start: at('11:00:00'), end: at('12:10:00') }],
  };
  it('prefers the clip, then stills, then previews, then nothing; future after now', () => {
    expect(sourceAt(cov, at('12:00:10'), NOW)).toEqual({ kind: 'clip', clip: c, offsetMs: 10_000 });
    expect(sourceAt(cov, at('12:01:00.500'), NOW)).toEqual({ kind: 'still', ts: at('12:01:00') });
    expect(sourceAt(cov, at('12:07:00'), NOW)).toEqual({ kind: 'preview', ts: at('12:07:00') });
    expect(sourceAt(cov, at('13:00:00'), NOW)).toEqual({ kind: 'none' });
    expect(sourceAt(cov, NOW, NOW)).toEqual({ kind: 'future' });
  });
  it('plays a recorded clip even after now (a camera clock ahead of the browser)', () => {
    expect(sourceAt(cov, at('12:00:10'), at('12:00:05'))).toEqual({ kind: 'clip', clip: c, offsetMs: 10_000 });
    expect(nextChange(cov, at('11:59:30'), at('11:59:00'))).toBe(at('12:00:00'));
    expect(nextChange(cov, at('12:30:00'), at('12:00:05'))).toBeNull();
  });

  it('names the next moment the source may change', () => {
    expect(nextChange(cov, at('11:59:30'), NOW)).toBe(at('12:00:00'));
    expect(nextChange(cov, at('12:00:10'), NOW)).toBe(at('12:00:30'));
    expect(nextChange(cov, at('12:11:00'), NOW)).toBe(NOW);
    expect(nextChange(cov, NOW, NOW)).toBeNull();
  });
});

describe('window and spans', () => {
  it('has a 30-minute window', () => {
    expect(windowAround(10 * 3_600_000, 0.5)).toEqual({ start: 9.75 * 3_600_000, end: 10.25 * 3_600_000 });
    expect(STRIP_ZOOMS).toEqual([24, 6, 3, 1, 0.5, 1 / 6, 1 / 60]);
  });

  // Klaus, 2026-10-04: 12 h went; a saved 12 h reads as 6 h, anything else unknown as 24 h.
  it('maps a saved zoom to one it offers, and names each', () => {
    expect(normalizeZoom(12)).toBe(6);
    expect(normalizeZoom(1 / 6)).toBe(1 / 6);
    expect(normalizeZoom(0.1666666667)).toBe(1 / 6);
    expect(normalizeZoom(5)).toBe(24);
    expect(normalizeZoom(undefined)).toBe(24);
    expect(STRIP_ZOOMS.map(zoomKey)).toEqual(['24', '6', '3', '1', '30m', '10m', '1m']);
    expect(STRIP_ZOOMS.map(zoomLabel)).toEqual(['24 h', '6 h', '3 h', '1 h', '30 min', '10 min', '1 min']);
    expect(windowAround(10 * 3_600_000, 1 / 60)).toEqual({ start: 10 * 3_600_000 - 30_000, end: 10 * 3_600_000 + 30_000 });
  });

  it('centres the window on t', () => {
    expect(windowAround(10 * 3_600_000, 1)).toEqual({ start: 9.5 * 3_600_000, end: 10.5 * 3_600_000 });
    expect(windowAround(10 * 3_600_000, 24)).toEqual({ start: -2 * 3_600_000, end: 22 * 3_600_000 });
  });
  it('colours the window: pictures (stills or previews), nothing, and outside (future)', () => {
    const cov: Coverage = { clips: [], stills: [{ start: 0, end: 25 }], previews: [{ start: 0, end: 50 }] };
    expect(stripSpans(cov, { start: 0, end: 100 }, 75)).toEqual([
      { kind: 'pictures', left: 0, width: 50 },
      { kind: 'none', left: 50, width: 25 },
      { kind: 'outside', left: 75, width: 25 },
    ]);
  });

  it('marks before the oldest content as outside too (Klaus, 2026-09-28)', () => {
    const cov: Coverage = { clips: [], stills: [], previews: [{ start: 30, end: 50 }] };
    expect(stripSpans(cov, { start: 0, end: 100 }, 80, 20)).toEqual([
      { kind: 'outside', left: 0, width: 20 },
      { kind: 'none', left: 20, width: 10 },
      { kind: 'pictures', left: 30, width: 20 },
      { kind: 'none', left: 50, width: 30 },
      { kind: 'outside', left: 80, width: 20 },
    ]);
  });
});

describe('ids and days', () => {
  it('reads a clip id as local time', () => {
    expect(clipStartFromId('20260927-120505-120530')).toBe(at('12:05:05'));
    expect(clipStartFromId('nonsense')).toBeNull();
  });
  it('lists the local days a span touches, DST-safe', () => {
    expect(localDaysBetween(at('23:00:00', '2026-09-26'), at('01:00:00', '2026-09-28'))).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    // 2026-11-01 is 25 hours long in Chicago
    const fallStart = new Date(2026, 10, 1).getTime();
    expect(localDaysBetween(fallStart, fallStart + 24.5 * 3_600_000)).toEqual(['2026-11-01']);
  });
});

// cam2 (cam-sim) drops preview tiles all the time: ~10 800 separate runs over
// three days froze the page (stripSpans is recomputed every second while live).
describe('previews with many missing tiles (production freeze, 2026-09-28)', () => {
  const T0 = Date.parse('2026-09-28T00:00:00-05:00');
  // 72 h of minutes, every 7th tile missing.
  const gappy: PreviewMinute[] = Array.from({ length: 72 * 60 }, (_, k) => ({
    minute: T0 - 48 * 3_600_000 + k * 60_000, url: '', cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1,
    present: Array.from({ length: 60 }, (_, i) => (k * 60 + i) % 7 !== 3),
  }));

  it('reads a single missing tile as part of the run, as with stills', () => {
    expect(previewRuns(gappy).length).toBe(1);
  });

  it('keeps a real hole (over 2 s) in the previews', () => {
    const m: PreviewMinute = { ...gappy[0], present: Array.from({ length: 60 }, (_, i) => i < 10 || i >= 20) };
    expect(previewRuns([m])).toEqual([{ start: m.minute, end: m.minute + 10_000 }, { start: m.minute + 20_000, end: m.minute + 60_000 }]);
  });

  it('draws a day of 20 000 separate runs quickly', () => {
    const runs = Array.from({ length: 20_000 }, (_, i) => ({ start: T0 + i * 4000, end: T0 + i * 4000 + 1000 }));
    const cov = { clips: [], stills: [], previews: runs };
    const t = performance.now();
    const spans = stripSpans(cov, { start: T0, end: T0 + 86_400_000 }, T0 + 86_400_000, null);
    expect(performance.now() - t).toBeLessThan(200);
    expect(spans.length).toBeGreaterThan(30_000);
    expect(sourceAt(cov, T0 + 4000 * 500 + 500, T0 + 86_400_000)).toMatchObject({ kind: 'preview' });
    expect(sourceAt(cov, T0 + 4000 * 500 + 2500, T0 + 86_400_000)).toMatchObject({ kind: 'none' });
  });
});
