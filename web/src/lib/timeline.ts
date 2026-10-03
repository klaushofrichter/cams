// The Timeline page's arithmetic (Plan 6). cam-proxy works in UTC ms; the
// page shows the browser's local day.
import { writable } from 'svelte/store';
import { DATE, localDate, saveCursor } from './recordings';
import { navigate } from './router';
import type { SummaryEntry } from './vision';

export interface PreviewMinute {
  minute: number; // UTC ms, a whole minute
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  intervalS: number;
  present: boolean[];
  url: string;
}

// [first ms, last ms] of a local YYYY-MM-DD (23 or 25 hours on DST days).
export function dayRange(date: string): [number, number] {
  const [y, mo, d] = date.split('-').map(Number);
  return [new Date(y, mo - 1, d).getTime(), new Date(y, mo - 1, d + 1).getTime() - 1];
}

export const minuteOf = (ts: number): number => Math.floor(ts / 60_000) * 60_000;

export function tileIndex(m: PreviewMinute, ts: number): number {
  return Math.min(m.cols * m.rows - 1, Math.max(0, Math.floor((ts - m.minute) / (m.intervalS * 1000))));
}

export function tileStyle(m: PreviewMinute, i: number, scale: number): string {
  return (
    `background-image:url('${m.url}');background-size:${m.cols * m.tileW * scale}px ${m.rows * m.tileH * scale}px;` +
    `background-position:-${(i % m.cols) * m.tileW * scale}px -${Math.floor(i / m.cols) * m.tileH * scale}px;width:${m.tileW * scale}px;height:${m.tileH * scale}px`
  );
}

export function hourGroups(minutes: PreviewMinute[]): { hour: number; minutes: PreviewMinute[] }[] {
  const out: { hour: number; minutes: PreviewMinute[] }[] = [];
  for (const m of minutes) {
    const hour = new Date(m.minute).getHours();
    const last = out[out.length - 1];
    if (last && last.hour === hour) last.minutes.push(m);
    else out.push({ hour, minutes: [m] });
  }
  return out;
}

// cam-proxy's list routes take at most a day: the 25-hour fall-back day
// goes in parts.
export function splitRange(from: number, to: number, max = 86_400_000): [number, number][] {
  const parts: [number, number][] = [];
  for (let a = from; a <= to; a += max) parts.push([a, Math.min(to, a + max - 1)]);
  return parts;
}

// The still to show for `target`: going forward the first at or after it,
// going back the last at or before it.
export function stillIndex(stills: number[], target: number, dir: 1 | -1): number {
  if (dir > 0) {
    const i = stills.findIndex((t) => t >= target);
    return i < 0 ? stills.length - 1 : i;
  }
  for (let i = stills.length - 1; i >= 0; i--) if (stills[i] <= target) return i;
  return 0;
}

export interface TimelineCursor {
  cam: string | null;
  date: string;
  t: number | null; // the open still, unix ms
}

export function timelineCursor(params: URLSearchParams, today: string): TimelineCursor {
  const date = params.get('date') ?? '';
  const t = params.get('t') ?? '';
  const cam = params.get('cam');
  return {
    cam: cam && /^[a-z0-9][a-z0-9-]{0,31}$/.test(cam) ? cam : null,
    date: DATE.test(date) ? date : today,
    t: /^\d{1,15}$/.test(t) ? Number(t) : null,
  };
}

export function timelineSearch(c: TimelineCursor): string {
  const p = new URLSearchParams();
  if (c.cam) p.set('cam', c.cam);
  p.set('date', c.date);
  if (c.t !== null) p.set('t', String(c.t));
  return `?${p.toString()}`;
}

// The sprite tile showing a moment, for the scrub preview (Plan 7): null
// when that minute has no sprite or that second no tile.
export function previewAt(minutes: PreviewMinute[], ts: number): { minute: PreviewMinute; index: number } | null {
  const m = minutes.find((x) => x.minute === minuteOf(ts));
  if (!m) return null;
  const index = tileIndex(m, ts);
  return m.present[index] ? { minute: m, index } : null;
}

// The view point shared by History, Live and the Timeline (Klaus,
// 2026-09-29): the last History time, or null for Live ("now"), per camera,
// for this browser session.
const VIEW_POINT_KEY = 'cams.viewPoint';

export function saveViewPoint(cam: string, at: number | null): void {
  try {
    sessionStorage.setItem(VIEW_POINT_KEY, JSON.stringify({ cam, at }));
  } catch {
    // not remembered this session
  }
}

// A second as the shared cursor (Klaus, 2026-09-29): the view point and
// History's cursor, so History and the Timeline continue from it.
export function shareViewPoint(cam: string, ts: number): void {
  saveViewPoint(cam, ts);
  saveCursor(cam, { date: localDate(new Date(ts)), clipId: null, offsetSec: 0, at: ts });
}

// History at a second, paused (Klaus, 2026-09-30): "Open in History" on the
// Timeline's large still and in the Vision dialog.
export const historyHref = (cam: string, ts: number) => `/app/recordings?cam=${encodeURIComponent(cam)}&panel=history&at=${ts}`;

// History's playhead to a second, paused (the video page handles it). The URL
// alone can't say it when History is already within a second of it and
// playing: the page takes that for its own report, or the URL doesn't change.
export const historySeek = writable<{ cam: string; at: number } | null>(null);
// The Vision dialog's "Open in History": the shared cursor, History's URL, and a stop there.
export function openHistory(cam: string, ts: number): void {
  shareViewPoint(cam, ts);
  navigate(historyHref(cam, ts));
  historySeek.set({ cam, at: ts });
}

export function loadViewPoint(cam: string): { at: number | null } | undefined {
  try {
    const v = JSON.parse(sessionStorage.getItem(VIEW_POINT_KEY) ?? 'null') as { cam?: unknown; at?: unknown } | null;
    if (!v || v.cam !== cam) return undefined;
    if (v.at === null) return { at: null };
    return typeof v.at === 'number' && Number.isSafeInteger(v.at) && v.at > 0 ? { at: v.at } : undefined;
  } catch {
    return undefined;
  }
}

// The minute whose sprite holds `t`, else the one nearest to it (for "now":
// the newest, since the current minute may have no sprite yet).
export function nearestMinute(minutes: PreviewMinute[], t: number): PreviewMinute | null {
  let best: PreviewMinute | null = null;
  let bestD = Infinity;
  for (const m of minutes) {
    const d = t < m.minute ? m.minute - t : t > m.minute + 59_999 ? t - (m.minute + 59_999) : 0;
    if (d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

// The minute view (spec 2026-09-30-analytics-in-cams-design, cam-proxy's
// model): a minute opens under its hour, steps ◀ ▶ within that hour, and
// marks its seconds by the cards (recordings) and Vision's analysed stills.
export interface SeenStill { eventId: number; stillTs: number; summary: SummaryEntry[] }
export interface TimelineCard { id: string; start: string; end: string; triggers: string[]; analysis?: { stills: SeenStill[] } }

const MINUTE = 60_000;
const spanOf = (c: { start: string; end: string }) => [Date.parse(c.start), Date.parse(c.end)] as const;

// The neighbouring minute of the same hour, or null at the hour's first or
// last one (no crossing into another hour).
export function stepMinute(hour: { minute: number }[], current: number, dir: -1 | 1): number | null {
  const i = hour.findIndex((m) => m.minute === current);
  if (i < 0) return null;
  return hour[i + dir]?.minute ?? null;
}

// A card ending exactly where the minute starts is the minute before's (issue #109).
const inMinute = (s: number, e: number, minute: number) => s < minute + MINUTE && (e > minute || (e === s && s === minute));

export function cardsInMinute<T extends { start: string; end: string }>(m: { minute: number }, cards: T[]): T[] {
  return cards
    .filter((c) => {
      const [s, e] = spanOf(c);
      return inMinute(s, e, m.minute);
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

const PRIORITY = ['person', 'vehicle', 'pet', 'motion', 'timer'];
const rank = (k: string) => {
  const i = PRIORITY.indexOf(k);
  return i < 0 ? PRIORITY.length : i;
};

// A card's colour: its most specific trigger (person before vehicle, pet, motion).
export function cardKind(c: { triggers: readonly string[] }): string {
  return [...c.triggers].sort((a, b) => rank(a) - rank(b))[0] ?? 'motion';
}

export function secondKinds(m: { minute: number; intervalS: number; present: boolean[] }, cards: { start: string; end: string; triggers: readonly string[] }[]): (string | null)[] {
  const list = cardsInMinute(m, cards);
  return m.present.map((_, i) => {
    const from = m.minute + i * m.intervalS * 1000;
    const to = from + m.intervalS * 1000 - 1;
    let best: string | null = null;
    for (const c of list) {
      const [s, e] = spanOf(c);
      const k = cardKind(c);
      if (s <= to && e >= from && (best === null || rank(k) < rank(best))) best = k;
    }
    return best;
  });
}

// Vision's analysed stills that found something (a non-empty summary).
export function seenStills(cards: TimelineCard[]): SeenStill[] {
  return cards.flatMap((c) => c.analysis?.stills.filter((s) => s.summary.length > 0) ?? []);
}

// The hour grid's data for every minute of the day at once (issue #109: not
// per tile): its cards, their count, the minute's colour and Vision's mark.
export interface MinuteInfo<T> { cards: T[]; kind: string | null; count: number; analysed: boolean }
export function minuteIndex<T extends TimelineCard>(minutes: { minute: number }[], cards: T[]): Map<number, MinuteInfo<T>> {
  const out = new Map<number, MinuteInfo<T>>(minutes.map((m) => [m.minute, { cards: [], kind: null, count: 0, analysed: false }]));
  const sorted = cards.map((c) => ({ c, span: spanOf(c) })).sort((a, b) => a.span[0] - b.span[0]);
  for (const { c, span: [s, e] } of sorted) {
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    for (let m = minuteOf(s); m <= e; m += MINUTE) {
      const x = out.get(m);
      if (!x || !inMinute(s, e, m)) continue;
      x.cards.push(c);
      x.count++;
      const k = cardKind(c);
      if (x.kind === null || rank(k) < rank(x.kind)) x.kind = k;
    }
  }
  for (const st of seenStills(cards)) {
    const x = out.get(minuteOf(st.stillTs));
    if (x) x.analysed = true;
  }
  return out;
}

// Per tile of the minute, the analysed still in that second, or null.
export function analysedSeconds(m: { minute: number; intervalS: number; present: boolean[] }, cards: TimelineCard[]): (SeenStill | null)[] {
  const stills = seenStills(cards);
  return m.present.map((_, i) => {
    const from = m.minute + i * m.intervalS * 1000;
    return stills.find((s) => s.stillTs >= from && s.stillTs < from + m.intervalS * 1000) ?? null;
  });
}
