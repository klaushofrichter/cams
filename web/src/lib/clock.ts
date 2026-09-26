import { readable } from 'svelte/store';

// The browser's own time zone: the viewer's local time, as the rest of the UI.
export function formatNow(d: Date, locale?: string): string {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
  return `${time} ${timeZoneLabel(d, locale)}`;
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
