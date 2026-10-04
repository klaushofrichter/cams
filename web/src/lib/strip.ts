// web/src/lib/strip.ts
import { addDays, localDate, orderTriggers, pad2, tagText, TRIGGER_LABELS, type EventClip } from './recordings';
import type { PreviewMinute } from './timeline';

// The History strip (spec 2026-09-27-history-strip-design.md): what is at a
// moment, from the runs of clips, stills and preview tiles a camera has.
// Times are UTC ms; runs are [start, end).

// The window's width in hours (the saved preference `timelineZoom`). Klaus,
// 2026-10-04: no 12 h; 10 min and 1 min added (1/6 and 1/60 of an hour).
export type StripZoom = number;
export const STRIP_ZOOMS: readonly StripZoom[] = [24, 6, 3, 1, 0.5, 1 / 6, 1 / 60];

// A saved zoom as one the strip offers: 12 h (gone) is 6 h; anything else
// unknown is 24 h. A near match (a rounded 1/6) counts.
export function normalizeZoom(z: unknown): StripZoom {
  if (z === 12) return 6;
  if (typeof z !== 'number') return 24;
  return STRIP_ZOOMS.find((x) => Math.abs(x - z) < 1e-6) ?? 24;
}
const minutesOf = (z: StripZoom) => Math.round(z * 60);
// "30 min", not "0.5 h" (issue #69); the test id the same way: zoom-30m.
export const zoomKey = (z: StripZoom) => (z >= 1 ? `${z}` : `${minutesOf(z)}m`);
export const zoomLabel = (z: StripZoom) => (z >= 1 ? `${z} h` : `${minutesOf(z)} min`);
export const zoomWords = (z: StripZoom) => (z >= 1 ? `${z} hour${z === 1 ? '' : 's'}` : `${minutesOf(z)} minute${minutesOf(z) === 1 ? '' : 's'}`);

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

// Previous/next event from `at` among the clips the filter shows: the next
// start after it, or the previous one before it (1.5 s in still counts as
// "this" event, so ⏮ goes to the one before). None at the first/last.
export function eventStep(clips: ClipRun[], visible: ReadonlySet<string>, at: number, dir: -1 | 1): ClipRun | undefined {
  const list = clips.filter((c) => visible.has(c.clip.id));
  return dir > 0 ? list.find((c) => c.start > at + 500) : [...list].reverse().find((c) => c.start < at - 1500);
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

// --- ticks under the bar ---
// Counted from each local midnight (so they sit on local hours in any time
// zone), labelled with the wall clock (the repeated hour on the 25-hour day
// shows twice); the date at midnight. Each zoom has its step (24 h: 3 h …
// 1 min: 15 s); a narrow bar (a phone) takes the next larger step until the
// labels are far enough apart (review of #171, 2026-10-04). Below a minute
// every label has its seconds.
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const TICK_STEPS = [10 * S, 15 * S, 30 * S, M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M, H, 2 * H, 3 * H, 6 * H, 12 * H, 24 * H];
const ZOOM_STEP: [StripZoom, number][] = [[24, 3 * H], [6, H], [3, 30 * M], [1, 15 * M], [0.5, 5 * M], [1 / 6, 2 * M], [1 / 60, 15 * S]];
export const TICK_CHAR_PX = 6.5; // a 10 px monospace character, rounded up
const TICK_GAP_PX = 10;
const labelPx = (chars: number) => chars * TICK_CHAR_PX;
const minSpacing = (step: number) => labelPx(step < M ? 8 : 5) + TICK_GAP_PX; // "12:00:30" or "12:00"

export function tickStep(zoom: StripZoom, widthPx: number): number {
  const span = zoom * H;
  let step = ZOOM_STEP.find(([z]) => zoom >= z - 1e-9)?.[1] ?? 15 * S;
  if (!(widthPx > 0)) return step;
  for (const s of TICK_STEPS) if (s >= step && (s / span) * widthPx >= minSpacing(s)) return s;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

export interface Tick { t: number; left: number; label: string; align: 'start' | 'center' | 'end' }

// The ticks in the window. With the bar's width known, a label that would
// stick out at an edge is aligned to it, and one that would then touch its
// neighbour is left out.
export function stripTicks(win: Run, zoom: StripZoom, widthPx: number): Tick[] {
  const step = tickStep(zoom, widthPx);
  const span = win.end - win.start;
  const times: number[] = [];
  for (let day = localDate(new Date(win.start)); ; day = addDays(day, 1)) {
    const [y, m, dd] = day.split('-').map(Number);
    const midnight = new Date(y, m - 1, dd).getTime();
    if (midnight > win.end) break;
    const next = new Date(y, m - 1, dd + 1).getTime();
    // From the first tick in the window, not from midnight (a 15 s step).
    for (let t = midnight + Math.max(0, Math.ceil((win.start - midnight) / step)) * step; t < next && t <= win.end; t += step) times.push(t);
  }
  const out: Tick[] = [];
  let lastEnd = -Infinity;
  for (const t of times) {
    const d = new Date(t);
    const label = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
      ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`
      : `${pad2(d.getHours())}:${pad2(d.getMinutes())}${step < M ? `:${pad2(d.getSeconds())}` : ''}`;
    const left = ((t - win.start) / span) * 100;
    if (!(widthPx > 0)) {
      out.push({ t, left, label, align: 'center' });
      continue;
    }
    const w = labelPx(label.length);
    const px = (left / 100) * widthPx;
    const align: Tick['align'] = px - w / 2 < 0 ? 'start' : px + w / 2 > widthPx ? 'end' : 'center';
    const from = align === 'start' ? px : align === 'end' ? px - w : px - w / 2;
    if (from < lastEnd + (out.length ? TICK_GAP_PX / 2 : 0)) continue;
    lastEnd = from + w;
    out.push({ t, left, label, align });
  }
  return out;
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

// The hover popup's types (Klaus, 2026-10-04): an icon per type of the clip
// under the pointer, in the cards' order (orderTriggers: motion, person,
// vehicle, pet; two or more events of an AI type with their count), or
// "Still" over the stills. A clip with none of these (a scheduled
// recording) gets a neutral clip icon, so the slot never looks empty.
export type HoverKind = 'person' | 'vehicle' | 'pet' | 'motion' | 'still' | 'clip';
export interface HoverSlot { kind: HoverKind; label: string; count: number }
const DRAWN = new Set<string>(['person', 'vehicle', 'pet', 'motion']);
export const STILL_SLOT: HoverSlot = { kind: 'still', label: 'Still', count: 0 };
export function hoverKinds(clip: EventClip): HoverSlot[] {
  const slots = orderTriggers(clip.triggers.filter((k) => DRAWN.has(k))).map((k): HoverSlot => {
    const count = k === 'motion' ? 0 : (clip.counts?.[k as 'person' | 'vehicle' | 'pet'] ?? 0);
    return { kind: k as HoverKind, label: tagText(k, clip.counts), count: count >= 2 ? count : 0 };
  });
  if (slots.length) return slots;
  return [{ kind: 'clip', label: clip.triggers.length ? clip.triggers.map((t) => TRIGGER_LABELS[t] ?? t).join(', ') : 'Recording', count: 0 }];
}
