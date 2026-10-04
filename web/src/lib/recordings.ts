import type { CardAnalysis } from './vision';
export type Trigger = 'person' | 'vehicle' | 'pet' | 'motion' | 'timer';
// The event filter: the kinds shown, several at once (Klaus, 2026-09-28);
// all four is "All". Always in ALL_KINDS order.
export type FilterKind = 'person' | 'vehicle' | 'pet' | 'motion';
export type Filter = FilterKind[];

export interface EventClip {
  id: string;
  start: string;
  end: string;
  durationSec: number;
  triggers: Trigger[];
  sizeSub: number | null;
  sizeMain: number | null;
  analysis?: CardAnalysis; // cam-proxy's Vision results, when it analysed this recording
  // cam-proxy's person, vehicle and pet events in this recording, per type (Klaus, 2026-10-04).
  counts?: Partial<Record<'person' | 'vehicle' | 'pet', number>>;
  // Which still the card's thumbnail is (the server's thumbPlan): a new one
  // after a later Vision confirmation is a new image request.
  thumb?: string;
}

export interface Cursor {
  date: string;
  clipId: string | null;
  offsetSec: number;
  at: number | null; // the strip position (UTC ms); null: from clipId/offsetSec, or the day's first event
}

export const TRIGGER_LABELS: Record<Trigger, string> = {
  person: 'Person',
  vehicle: 'Vehicle',
  pet: 'Pet',
  motion: 'Motion',
  timer: 'Scheduled',
};
// A card's tag: the kind, and from two events of an AI type on how many
// ("Person 2x", Klaus 2026-10-04). Motion and Scheduled never get a count.
export function tagText(t: Trigger, counts: EventClip['counts']): string {
  const n = t === 'person' || t === 'vehicle' || t === 'pet' ? (counts?.[t] ?? 0) : 0;
  return n >= 2 ? `${TRIGGER_LABELS[t]} ${n}x` : TRIGGER_LABELS[t];
}
// The order a card lists its kinds in (Klaus, 2026-10-01): Motion first,
// then Person, Vehicle, Pet, Scheduled; the camera's own order varies. Only
// the display: kinds this list doesn't know follow, in their order.
const TRIGGER_ORDER: readonly string[] = ['motion', 'person', 'vehicle', 'pet', 'timer'];
export function orderTriggers<T extends string>(triggers: readonly T[]): T[] {
  const rank = (t: string) => {
    const i = TRIGGER_ORDER.indexOf(t);
    return i < 0 ? TRIGGER_ORDER.length : i;
  };
  return [...triggers].sort((a, b) => rank(a) - rank(b));
}
export const ALL_KINDS: FilterKind[] = ['person', 'vehicle', 'pet', 'motion'];
export const isAllKinds = (f: Filter) => ALL_KINDS.every((k) => f.includes(k));
// A URL value, a stored preference (a list, or an old single value), or junk.
export function parseFilter(v: string | string[] | null | undefined): Filter {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const f = ALL_KINDS.filter((k) => parts.includes(k));
  return f.length ? f : [...ALL_KINDS];
}
export const filterParam = (f: Filter) => (isAllKinds(f) ? 'all' : f.join(','));
// A chip: from All, a kind shows only it; the last kind off is All again.
export function toggleFilter(f: Filter, k: FilterKind | 'all'): Filter {
  if (k === 'all') return [...ALL_KINDS];
  if (isAllKinds(f)) return [k];
  const next = f.includes(k) ? f.filter((x) => x !== k) : [...f, k];
  return next.length ? ALL_KINDS.filter((x) => next.includes(x)) : [...ALL_KINDS];
}
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIP = /^\d{8}-\d{6}-\d{6}$/;
const CURSOR_KEY = 'cams-cursor';

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

export function filterEvents(events: EventClip[], filter: Filter): EventClip[] {
  return isAllKinds(filter) ? events : events.filter((e) => e.triggers.some((t) => (filter as string[]).includes(t)));
}
// HH:MM:SS, local.
export function formatClock(t: string | number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad2).join(':');
}

const cam = (id: string) => encodeURIComponent(id);
export const eventsUrl = (c: string, date: string) => `/api/cameras/${cam(c)}/events?date=${encodeURIComponent(date)}`;
export const daysUrl = (c: string, month: string) => `/api/cameras/${cam(c)}/days?month=${encodeURIComponent(month)}`;
export const videoUrl = (c: string, id: string) => `/api/cameras/${cam(c)}/clips/${encodeURIComponent(id)}/video`;
// The stream videoUrl plays: the server's clip route serves the sub (SD) file
// (RecordingsService.withClip). The REC badge says so (Klaus, 2026-10-04).
export const VIDEO_STREAM: 'sub' | 'main' = 'sub';
export const thumbUrl = (c: string, id: string, version?: string) =>
  `/api/cameras/${cam(c)}/clips/${encodeURIComponent(id)}/thumb.jpg${version ? `?v=${encodeURIComponent(version)}` : ''}`;
export const downloadUrl = (c: string, id: string, q: 'sub' | 'main') => `/api/cameras/${cam(c)}/clips/${encodeURIComponent(id)}/download?quality=${q}`;

// No event filter: that is the saved preference only (eventFilter.ts); an
// old link's `filter=` is ignored (Klaus, 2026-10-03).
export function parseCursor(params: URLSearchParams, today: string): { cam: string | null; cursor: Cursor } {
  const date = params.get('date') ?? '';
  const clip = params.get('clip') ?? '';
  const t = Number(params.get('t'));
  const atRaw = params.get('at') ?? '';
  return {
    cam: params.get('cam'),
    cursor: {
      date: DATE.test(date) ? date : today,
      clipId: CLIP.test(clip) ? clip : null,
      offsetSec: Number.isFinite(t) && t > 0 ? Math.floor(t) : 0,
      at: /^\d{12,14}$/.test(atRaw) ? Number(atRaw) : null,
    },
  };
}

// The Video page's query (spec 2026-10-04): no `panel` any more.
export function cursorSearch(c: string, cursor: Cursor): string {
  const p = new URLSearchParams({ cam: c, date: cursor.date });
  if (cursor.at !== null) p.set('at', String(Math.floor(cursor.at)));
  if (cursor.clipId) p.set('clip', cursor.clipId);
  if (cursor.at === null) p.set('t', String(Math.floor(cursor.offsetSec)));
  return `?${p.toString()}`;
}

export function saveCursor(c: string, cursor: Cursor): void {
  try {
    sessionStorage.setItem(CURSOR_KEY, JSON.stringify({ cam: c, cursor }));
  } catch {
    // not remembered this session
  }
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

// The label of a wall-clock hour (0–23, as getHours() gives it). Built from the
// hour itself, not from hour*3600 seconds after midnight: on a DST day those
// differ (the spring-forward 03:xx hour starts 2 h after midnight).
function hourLabel(date: string, hour: number, locale?: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, CLOCK).format(new Date(y, m - 1, d, hour));
}

export interface HourGroup {
  hour: number;
  label: string;
  events: EventClip[];
}
export const COLLAPSE_OVER = 10;

// Whether an hour group with no explicit open/closed state yet should start
// open: a busy hour starts collapsed unless it holds the current selection.
// Used by EventList so the template's initial
// render and the effect's later bookkeeping ever agree, and a busy hour's
// thumbnails are never built on the very first paint just to be torn down
// again once the effect decides it should have been collapsed.
export function defaultGroupOpen(g: HourGroup, selectedId: string | null): boolean {
  return g.events.length <= COLLAPSE_OVER || g.events.some((e) => e.id === selectedId);
}

export function groupByHour(events: EventClip[], date: string): HourGroup[] {
  const groups = new Map<number, EventClip[]>();
  for (const e of events) {
    const hour = new Date(e.start).getHours();
    if (!groups.has(hour)) groups.set(hour, []);
    groups.get(hour)!.push(e);
  }
  // Newest first, hours and events alike (Klaus, 2026-09-28).
  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([hour, list]) => ({
      hour,
      label: `${hourLabel(date, hour)}–${hourLabel(date, hour + 1)}`,
      events: [...list].sort((x, y) => Date.parse(y.start) - Date.parse(x.start)),
    }));
}

export function loadCursor(): { cam: string; cursor: Cursor } | null {
  try {
    const raw = sessionStorage.getItem(CURSOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cam?: unknown; cursor?: { date?: unknown; clipId?: unknown; offsetSec?: unknown; at?: unknown } };
    const cam = parsed.cam;
    const c = parsed.cursor;
    if (typeof cam !== 'string' || cam.length === 0 || !c) return null;
    const { date, clipId, offsetSec } = c;
    if (typeof date !== 'string' || !DATE.test(date)) return null;
    if (clipId !== null && (typeof clipId !== 'string' || !CLIP.test(clipId))) return null;
    if (typeof offsetSec !== 'number' || !Number.isFinite(offsetSec) || offsetSec < 0) return null;
    const at = typeof c.at === 'number' && Number.isFinite(c.at) && c.at > 0 ? c.at : null;
    return { cam, cursor: { date, clipId, offsetSec: Math.floor(offsetSec), at } };
  } catch {
    return null;
  }
}
