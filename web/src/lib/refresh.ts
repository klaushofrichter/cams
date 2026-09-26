import { readable } from 'svelte/store';
import { localDate } from './recordings';

export const REFRESH_MS = 60_000;
const MIN_GAP_MS = 10_000;

// Past days don't change; today gains clips. The server caches today's list
// for 30 s, so a minute's poll costs the camera at most one search pair.
export function createTodayRefresher(opts: { isToday: () => boolean; refresh: () => void; intervalMs?: number; doc?: Document }): { stop(): void } {
  const doc = opts.doc ?? document;
  let last = Date.now();
  const run = () => {
    if (doc.visibilityState === 'hidden' || !opts.isToday()) return;
    last = Date.now();
    opts.refresh();
  };
  const timer = setInterval(run, opts.intervalMs ?? REFRESH_MS);
  const onVisible = () => {
    if (doc.visibilityState === 'visible' && Date.now() - last >= MIN_GAP_MS) run();
  };
  doc.addEventListener('visibilitychange', onVisible);
  return {
    stop() {
      clearInterval(timer);
      doc.removeEventListener('visibilitychange', onVisible);
    },
  };
}

// "Today" in the browser's time zone, rolling over at local midnight.
export const todayDate = readable(localDate(new Date()), (set) => {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const n = new Date();
    const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 1);
    timer = setTimeout(() => {
      set(localDate(new Date()));
      schedule();
    }, next.getTime() - n.getTime());
  };
  const onVisible = () => document.visibilityState === 'visible' && set(localDate(new Date()));
  schedule();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
});
