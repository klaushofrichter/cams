// The Timeline page's arithmetic (Plan 6). cam-proxy works in UTC ms; the
// page shows the browser's local day.

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
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today,
    t: /^\d{1,15}$/.test(t) ? Number(t) : null,
  };
}

export function cursorSearch(c: TimelineCursor): string {
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
