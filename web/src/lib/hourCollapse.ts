import { defaultGroupOpen, type HourGroup } from './recordings';

// Stage 2 of the Video page (spec 2026-10-04): when the viewer lands on a new
// spot (a day picked, an event card, a link, going live, the page loading),
// the event list collapses the hours more than 6 h from the viewed time.
// Never while scrubbing or playing: only a landing applies this.
export const FAR_MS = 6 * 3_600_000;

// From `viewedAt` to the clock hour `hour` of `date`: 0 inside it, else the
// way to its nearer edge. Built from the wall-clock hour (a DST day's hours
// are not hour*3600 s after midnight).
function hourSpan(date: string, hour: number): [number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [new Date(y, m - 1, d, hour).getTime(), new Date(y, m - 1, d, hour + 1).getTime()];
}
export function hourDistance(date: string, hour: number, viewedAt: number): number {
  const [start, end] = hourSpan(date, hour);
  if (viewedAt < start) return start - viewedAt;
  if (viewedAt >= end) return viewedAt - end;
  return 0;
}
// The viewed time lies in this hour (its end belongs to the next one).
export function isViewedHour(date: string, hour: number, viewedAt: number): boolean {
  const [start, end] = hourSpan(date, hour);
  return viewedAt >= start && viewedAt < end;
}

// Whether an hour is open after a landing at `viewedAt`. The viewed hour is
// always open; otherwise the user's own choice (`manual`) wins; otherwise a
// far hour is closed, unless it holds the selection; a near one follows the
// usual default (a busy hour starts collapsed unless it holds the selection).
export function hourOpenAtLanding(g: HourGroup, date: string, viewedAt: number, selectedId: string | null, manual?: boolean): boolean {
  if (isViewedHour(date, g.hour, viewedAt)) return true;
  const dist = hourDistance(date, g.hour, viewedAt);
  if (manual !== undefined) return manual;
  if (dist > FAR_MS) return selectedId !== null && g.events.some((e) => e.id === selectedId);
  return defaultGroupOpen(g, selectedId);
}
