import { readable } from 'svelte/store';

// The browser's own time zone: the viewer's local time, as the rest of the UI.
export function formatNow(d: Date, locale?: string): string {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
  return `${time} ${timeZoneLabel(d, locale)}`;
}

// Roughly how long ago `t` was (Klaus, 2026-09-28): "just now" under a
// minute, then whole minutes, hours or days, rounded down.
export function timeAgo(t: number, now: number): string {
  const s = Math.floor((now - t) / 1000);
  if (s < 60) return 'just now';
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'} ago`;
  if (s < 3600) return n(Math.floor(s / 60), 'minute');
  if (s < 86_400) return n(Math.floor(s / 3600), 'hour');
  return n(Math.floor(s / 86_400), 'day');
}

export function timeZoneLabel(d: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
}

// Ticks on each whole second (aligned, so the display never skips a second).
export const now = readable(new Date(), (set) => {
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const t = Date.now();
    set(new Date(Math.floor(t / 1000) * 1000));
    timer = setTimeout(tick, 1000 - (t % 1000));
  };
  timer = setTimeout(tick, 1000 - (Date.now() % 1000));
  return () => clearTimeout(timer);
});
