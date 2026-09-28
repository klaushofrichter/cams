// web/src/lib/strip.test.ts
import { describe, expect, it } from 'vitest';
import {
  clipRuns, clipStartFromId, inRuns, localDaysBetween, mergeRuns, nextChange, previewRuns, sourceAt, stillRuns, stripSpans, windowAround,
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
  it('centres the window on t', () => {
    expect(windowAround(10 * 3_600_000, 1)).toEqual({ start: 9.5 * 3_600_000, end: 10.5 * 3_600_000 });
    expect(windowAround(10 * 3_600_000, 24)).toEqual({ start: -2 * 3_600_000, end: 22 * 3_600_000 });
  });
  it('colours the window: pictures (stills or previews), nothing, future', () => {
    const cov: Coverage = { clips: [], stills: [{ start: 0, end: 25 }], previews: [{ start: 0, end: 50 }] };
    expect(stripSpans(cov, { start: 0, end: 100 }, 75)).toEqual([
      { kind: 'pictures', left: 0, width: 50 },
      { kind: 'none', left: 50, width: 25 },
      { kind: 'future', left: 75, width: 25 },
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
