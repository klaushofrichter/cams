// web/src/lib/dayCache.ts
import { get, writable, type Readable } from 'svelte/store';
import { getJson } from './api';
import { addDays, eventsUrl, localDate, type EventClip } from './recordings';
import type { Change } from './eventStream';

// One `events` request per (camera, day), shared by the Recordings list and
// the History strip, so both never ask for the same day twice.
// Where a day's recordings come from (server/recordings/service.ts,
// downloadsState): the cam-proxy's recordings API (the SD card), its FTP
// copies when that failed, or the camera; 'unavailable' when a camera without
// a proxy refuses downloads.
export type Downloads = 'ok' | 'proxy-recordings' | 'proxy' | 'unavailable';
export interface DayEvents { events: EventClip[]; downloads: Downloads }

// The note under the player.
export function sourceLabel(d: Downloads): string {
  if (d === 'proxy-recordings') return 'cam-proxy (SD card)';
  if (d === 'proxy') return 'cam-proxy (FTP copies)';
  return 'camera';
}
export type Fetch = <T>(url: string) => Promise<T>;

const store = writable<Map<string, DayEvents>>(new Map());
export const dayStore: Readable<Map<string, DayEvents>> = { subscribe: store.subscribe };
const inflight = new Map<string, Promise<DayEvents>>();
// Days a change made stale (invalidateDays): their cards stay in the store
// for the readers (the History strip keeps its recordings) until a fresh
// answer replaces them, but the next loadDay asks again. Per key, `gen` is
// bumped by each change: an answer that was already on its way then fills
// an empty store only and leaves the day stale.
const stale = new Set<string>();
const gen = new Map<string, number>();
const listeners = new Set<(cam: string, day: string) => void>();

export function loadDay(cam: string, day: string, opts: { force?: boolean; fetch?: Fetch } = {}): Promise<DayEvents> {
  const key = `${cam}|${day}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const have = get(store).get(key);
  if (have && !opts.force && !stale.has(key)) return Promise.resolve(have);
  const fetch = opts.fetch ?? getJson;
  const g = gen.get(key) ?? 0;
  const p = fetch<{ events: EventClip[]; downloads?: DayEvents['downloads'] }>(eventsUrl(cam, day))
    .then((r) => {
      const v: DayEvents = { events: r.events, downloads: r.downloads ?? 'ok' };
      const fresh = (gen.get(key) ?? 0) === g;
      if (fresh) stale.delete(key);
      // The same answer again (a refresh that changed nothing): the cached
      // object stays, so its readers (the list, the strip) see no change.
      const old = get(store).get(key);
      if (old && JSON.stringify(old) === JSON.stringify(v)) return old;
      if (fresh || !old) store.update((m) => new Map(m).set(key, v));
      return v;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export function resetDayCache(): void {
  inflight.clear();
  stale.clear();
  gen.clear();
  store.set(new Map());
}

// A new analysis or still check (cams' relay of the proxy's `analysis` and
// `still-check` messages) changes the cards of the day that holds its second:
// their Vision badges, their thumbnails (Klaus, 2026-10-04). Days are the
// browser's local days, like everywhere in the app. A second within SLACK_MS
// of midnight may belong to a card of the other day (an analysis counts for a
// card from 5 s before it starts), and a card running past midnight holds
// seconds of the next day: a cached day whose cards hold the second counts too.
// Without a time, every cached day of the camera.
const SLACK_MS = 10_000;
export function affectedDays(cam: string, ts: number | null, cached: ReadonlyMap<string, DayEvents> = get(store)): string[] {
  const prefix = `${cam}|`;
  const mine = [...cached].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v] as const);
  if (ts === null) return mine.map(([d]) => d);
  const out = [localDate(new Date(ts))];
  for (const t of [ts - SLACK_MS, ts + SLACK_MS]) out.push(localDate(new Date(t)));
  for (const [d, v] of mine) if (v.events.some((e) => Date.parse(e.start) - SLACK_MS <= ts && ts <= Date.parse(e.end) + SLACK_MS)) out.push(d);
  return [...new Set(out)];
}

// Makes those days stale (cached or on their way) and tells the pages
// showing them.
export function invalidateDays(cam: string, ts: number | null): string[] {
  const days = affectedDays(cam, ts);
  for (const d of days) {
    const k = `${cam}|${d}`;
    gen.set(k, (gen.get(k) ?? 0) + 1);
    inflight.delete(k);
    stale.add(k);
  }
  for (const d of days) for (const fn of listeners) fn(cam, d);
  return days;
}

// A page showing a day (and the days around it, the Timeline) reloads it.
export function onDayInvalidated(fn: (cam: string, day: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Wired to the app's event stream when it opens (eventStream()).
export const DAY_CHANGES = ['analysis', 'still-check'];
export function followDayChanges(stream: { onChange(fn: (c: Change) => void): () => void }): () => void {
  return stream.onChange((c) => {
    if (DAY_CHANGES.includes(c.type)) invalidateDays(c.cam, typeof c.ts === 'number' ? c.ts : null);
  });
}

// Whether a day changed by (cam, changed) is one a page shows: that day, or
// for the Timeline (which reads the days around too) a neighbour.
export const isDayOrNeighbour = (day: string, changed: string) => changed === day || changed === addDays(day, -1) || changed === addDays(day, 1);
