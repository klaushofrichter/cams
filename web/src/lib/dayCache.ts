// web/src/lib/dayCache.ts
import { get, writable, type Readable } from 'svelte/store';
import { getJson } from './api';
import { eventsUrl, type EventClip } from './recordings';

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

export function loadDay(cam: string, day: string, opts: { force?: boolean; fetch?: Fetch } = {}): Promise<DayEvents> {
  const key = `${cam}|${day}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const have = get(store).get(key);
  if (have && !opts.force) return Promise.resolve(have);
  const fetch = opts.fetch ?? getJson;
  const p = fetch<{ events: EventClip[]; downloads?: DayEvents['downloads'] }>(eventsUrl(cam, day))
    .then((r) => {
      const v: DayEvents = { events: r.events, downloads: r.downloads ?? 'ok' };
      store.update((m) => new Map(m).set(key, v));
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function resetDayCache(): void {
  inflight.clear();
  store.set(new Map());
}
