export type Trigger = 'person' | 'vehicle' | 'pet' | 'motion' | 'timer';
export type Filter = 'all' | 'person' | 'vehicle' | 'pet' | 'motion';
export type Zoom = 24 | 6 | 1;

export interface EventClip {
  id: string;
  start: string;
  end: string;
  durationSec: number;
  triggers: Trigger[];
  sizeSub: number | null;
  sizeMain: number | null;
}

export interface Cursor {
  date: string;
  clipId: string | null;
  offsetSec: number;
}

export const TRIGGER_LABELS: Record<Trigger, string> = {
  person: 'Person',
  vehicle: 'Vehicle',
  pet: 'Pet',
  motion: 'Motion',
  timer: 'Scheduled',
};
export const FILTERS: Filter[] = ['all', 'person', 'vehicle', 'pet', 'motion'];
const AI: Trigger[] = ['person', 'vehicle', 'pet'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIP = /^\d{8}-\d{6}-\d{6}$/;
export const CURSOR_KEY = 'cams-cursor';

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

export function secondsIntoDay(iso: string, date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(iso).getTime() - new Date(y, m - 1, d).getTime()) / 1000;
}

export function timelineWindow(zoom: Zoom, centerSec: number): { start: number; end: number } {
  if (zoom === 24) return { start: 0, end: 86400 };
  const span = zoom * 3600;
  const start = Math.min(Math.max(0, centerSec - span / 2), 86400 - span);
  return { start, end: start + span };
}

export function layoutSegments(
  events: EventClip[],
  date: string,
  win: { start: number; end: number },
): { id: string; left: number; width: number; ai: boolean }[] {
  const span = win.end - win.start;
  return events
    .map((e) => {
      const s = secondsIntoDay(e.start, date);
      return { e, s, t: s + e.durationSec };
    })
    .filter(({ s, t }) => t > win.start && s < win.end)
    .map(({ e, s, t }) => ({
      id: e.id,
      left: ((Math.max(s, win.start) - win.start) / span) * 100,
      width: Math.max(0.4, ((Math.min(t, win.end) - Math.max(s, win.start)) / span) * 100),
      ai: e.triggers.some((x) => AI.includes(x)),
    }));
}

export function clipAtSecond(events: EventClip[], date: string, sec: number): EventClip | null {
  let best: EventClip | null = null;
  let bestDist = 300;
  for (const e of events) {
    const s = secondsIntoDay(e.start, date);
    if (sec >= s && sec <= s + e.durationSec) return e;
    const dist = Math.abs(s - sec);
    if (dist <= bestDist) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

export function neighbour(events: EventClip[], id: string, dir: -1 | 1): EventClip | null {
  const i = events.findIndex((e) => e.id === id);
  return i < 0 ? null : (events[i + dir] ?? null);
}

export function filterEvents(events: EventClip[], filter: Filter): EventClip[] {
  return filter === 'all' ? events : events.filter((e) => e.triggers.includes(filter));
}

export function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
}

const cam = (id: string) => encodeURIComponent(id);
export const eventsUrl = (c: string, date: string) => `/api/cameras/${cam(c)}/events?date=${date}`;
export const daysUrl = (c: string, month: string) => `/api/cameras/${cam(c)}/days?month=${month}`;
export const videoUrl = (c: string, id: string) => `/api/cameras/${cam(c)}/clips/${id}/video`;
export const thumbUrl = (c: string, id: string) => `/api/cameras/${cam(c)}/clips/${id}/thumb.jpg`;
export const downloadUrl = (c: string, id: string, q: 'sub' | 'main') => `/api/cameras/${cam(c)}/clips/${id}/download?quality=${q}`;

export function parseCursor(params: URLSearchParams, today: string): { cam: string | null; cursor: Cursor; filter: Filter } {
  const date = params.get('date') ?? '';
  const clip = params.get('clip') ?? '';
  const t = Number(params.get('t'));
  const f = params.get('filter') as Filter;
  return {
    cam: params.get('cam'),
    cursor: {
      date: DATE.test(date) ? date : today,
      clipId: CLIP.test(clip) ? clip : null,
      offsetSec: Number.isFinite(t) && t > 0 ? Math.floor(t) : 0,
    },
    filter: FILTERS.includes(f) ? f : 'all',
  };
}

export function cursorSearch(c: string, cursor: Cursor, panel: string, filter: Filter): string {
  const p = new URLSearchParams({ cam: c, date: cursor.date });
  if (cursor.clipId) p.set('clip', cursor.clipId);
  p.set('t', String(Math.floor(cursor.offsetSec)));
  p.set('panel', panel);
  p.set('filter', filter);
  return `?${p.toString()}`;
}

export function saveCursor(c: string, cursor: Cursor): void {
  try {
    sessionStorage.setItem(CURSOR_KEY, JSON.stringify({ cam: c, cursor }));
  } catch {
    // not remembered this session
  }
}

export function loadCursor(): { cam: string; cursor: Cursor } | null {
  try {
    const raw = sessionStorage.getItem(CURSOR_KEY);
    return raw ? (JSON.parse(raw) as { cam: string; cursor: Cursor }) : null;
  } catch {
    return null;
  }
}
