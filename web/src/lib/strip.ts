// web/src/lib/strip.ts
import { addDays, localDate, type EventClip } from './recordings';
import type { PreviewMinute } from './timeline';

// The History strip (spec 2026-09-27-history-strip-design.md): what is at a
// moment, from the runs of clips, stills and preview tiles a camera has.
// Times are UTC ms; runs are [start, end).

export type StripZoom = 24 | 12 | 6 | 3 | 1 | 0.5;
export const STRIP_ZOOMS: StripZoom[] = [24, 12, 6, 3, 1, 0.5];

export interface Run { start: number; end: number }
export interface ClipRun extends Run { clip: EventClip }
export interface Coverage { clips: ClipRun[]; stills: Run[]; previews: Run[] }
export type Source =
  | { kind: 'clip'; clip: EventClip; offsetMs: number }
  | { kind: 'still'; ts: number }
  | { kind: 'preview'; ts: number }
  | { kind: 'none' }
  | { kind: 'future' };
// 'pictures': a still or a preview tile exists (one colour: both are pictures).
// 'outside': after now, or before the oldest content (striped, Klaus 2026-09-28).
export type SpanKind = 'pictures' | 'none' | 'outside';

export const EMPTY_COVERAGE: Coverage = { clips: [], stills: [], previews: [] };

export function mergeRuns(runs: Run[], gapMs = 0): Run[] {
  const sorted = runs.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Run[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gapMs) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

export function inRuns<T extends Run>(runs: T[], t: number): T | null {
  for (const r of runs) if (t >= r.start && t < r.end) return r;
  return null;
}

// The first of sorted, non-overlapping runs (mergeRuns' output) that ends
// after t: a binary search, since a camera dropping frames has thousands of
// runs and the strip asks for every boundary each second.
function firstEndingAfter(runs: Run[], t: number): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function inMerged(runs: Run[], t: number): Run | null {
  const r = runs[firstEndingAfter(runs, t)];
  return r && t >= r.start ? r : null;
}

export function clipRuns(events: EventClip[], failed: ReadonlySet<string> = new Set()): ClipRun[] {
  return events
    .filter((e) => !failed.has(e.id))
    .map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end), clip: e }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
}

// One still per second; a few missing seconds still read as one run (the
// player shows the last good frame).
export function stillRuns(ts: number[]): Run[] {
  return mergeRuns(ts.map((t) => ({ start: t, end: t + 1000 })), 2000);
}

export function previewRuns(minutes: PreviewMinute[]): Run[] {
  const runs: Run[] = [];
  for (const m of minutes) {
    const step = m.intervalS * 1000;
    m.present.forEach((on, i) => {
      if (on) runs.push({ start: m.minute + i * step, end: m.minute + (i + 1) * step });
    });
  }
  // As with stills, a missing tile or two reads as one run (cam-sim drops
  // many: thousands of runs froze the page, 2026-09-28).
  return mergeRuns(runs, 2000);
}

// A recorded clip wins even after `now`: the camera's clock can run ahead of
// the browser's, and a clip that exists has been recorded.
export function sourceAt(cov: Coverage, t: number, now: number): Source {
  const c = inRuns(cov.clips, t);
  if (c) return { kind: 'clip', clip: c.clip, offsetMs: t - c.start };
  if (t >= now) return { kind: 'future' };
  const second = Math.floor(t / 1000) * 1000;
  if (inMerged(cov.stills, t)) return { kind: 'still', ts: second };
  if (inMerged(cov.previews, t)) return { kind: 'preview', ts: second };
  return { kind: 'none' };
}

// The next boundary after t where sourceAt may give something else.
export function nextChange(cov: Coverage, t: number, now: number): number | null {
  let best = t < now ? now : Infinity;
  for (const r of cov.clips) {
    if (r.start > t && r.start < best) best = r.start;
    if (r.end > t && r.end < best) best = r.end;
  }
  if (t < now) {
    for (const list of [cov.stills, cov.previews]) {
      const r = list[firstEndingAfter(list, t)];
      if (r) best = Math.min(best, r.start > t ? r.start : r.end);
    }
  }
  return best === Infinity ? null : best;
}

export function windowAround(t: number, zoom: StripZoom): Run {
  const half = (zoom * 3_600_000) / 2;
  return { start: t - half, end: t + half };
}

export function stripSpans(cov: Coverage, win: Run, now: number, oldest: number | null = null): { kind: SpanKind; left: number; width: number }[] {
  const cuts = new Set<number>([win.start, win.end]);
  if (now > win.start && now < win.end) cuts.add(now);
  if (oldest !== null && oldest > win.start && oldest < win.end) cuts.add(oldest);
  for (const list of [cov.stills, cov.previews]) {
    for (const r of list) {
      if (r.start > win.start && r.start < win.end) cuts.add(r.start);
      if (r.end > win.start && r.end < win.end) cuts.add(r.end);
    }
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const len = win.end - win.start;
  const out: { kind: SpanKind; left: number; width: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const mid = (a + b) / 2;
    const outside = mid >= now || (oldest !== null && mid < oldest);
    const kind: SpanKind = outside ? 'outside' : inMerged(cov.stills, mid) || inMerged(cov.previews, mid) ? 'pictures' : 'none';
    const last = out[out.length - 1];
    const left = ((a - win.start) / len) * 100;
    const width = ((b - a) / len) * 100;
    if (last && last.kind === kind) last.width += width;
    else out.push({ kind, left, width });
  }
  return out;
}

const ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d{6}$/;
export function clipStartFromId(id: string): number | null {
  const m = ID.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

// The local calendar days [from, to] touches (by calendar, not by 24 h steps).
export function localDaysBetween(from: number, to: number): string[] {
  const out: string[] = [];
  const last = localDate(new Date(to));
  for (let d = localDate(new Date(from)); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}
