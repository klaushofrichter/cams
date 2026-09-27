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
