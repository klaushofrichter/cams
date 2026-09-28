// web/src/lib/stripData.ts
import { derived, writable, get, type Readable } from 'svelte/store';
import { getJson } from './api';
import { dayStore, loadDay, type Fetch } from './dayCache';
import { addDays, localDate, type EventClip } from './recordings';
import { dayRange, splitRange, type PreviewMinute } from './timeline';
import { clipRuns, EMPTY_COVERAGE, localDaysBetween, mergeRuns, previewRuns, stillRuns, type Coverage, type Run } from './strip';

// A camera's strip data (spec: Strip / Data): events and previews per local
// day for the days a window touches plus one either side, stills per hour
// around the playhead. Every request is made once; a failed stills or
// previews request counts as empty and is tried again after a minute.
export interface StripData {
  coverage: Readable<Coverage>;
  events: Readable<EventClip[]>;                        // every loaded event, failed ones included
  previews: Readable<PreviewMinute[]>;
  ensure(from: number, to: number): void;
  ensureStills(t: number): void;
  markFailed(clipId: string): void;
  eventsOn(day: string): EventClip[] | null;
  destroy(): void;
}

const HOUR = 3_600_000;
const RETRY_MS = 60_000;
const FRESH_MS = 30_000; // today's previews and the current hour's stills are asked for again after this

export function createStripData(cam: string, proxy: boolean, fetch: Fetch = getJson): StripData {
  const days = new Set<string>();                       // days asked for
  const previewDays = new Map<string, PreviewMinute[]>();
  const stillHours = new Map<number, Run[]>();
  const failedAt = new Map<string, number>();           // `p|day` / `s|hour` → when it failed
  const failed = writable(new Set<string>());
  const bump = writable(0);                             // previews / stills changed
  const daysAsked = writable(0);                        // `days` grew (its data may already be cached)
  const enc = encodeURIComponent(cam);
  let alive = true;

  const retryable = (key: string) => {
    const t = failedAt.get(key);
    return t === undefined || Date.now() - t > RETRY_MS;
  };
  const fetchedAt = new Map<string, number>(); // `p|day` / `s|hour` → last successful load
  const inflight = new Set<string>();
  // Loaded, and (for data that still grows: today, the current hour) recently enough.
  const current = (key: string, growing: boolean) => {
    const t = fetchedAt.get(key);
    return t !== undefined && (!growing || Date.now() - t < FRESH_MS);
  };

  function loadPreviews(day: string) {
    const key = `p|${day}`;
    const [from, to] = dayRange(day);
    if (!proxy || inflight.has(key) || current(key, to >= Date.now()) || !retryable(key)) return;
    inflight.add(key);
    Promise.all(splitRange(from, to).map(([a, z]) => fetch<PreviewMinute[]>(`/api/cameras/${enc}/previews?from=${a}&to=${z}`)))
      .then((parts) => {
        if (!alive) return;
        previewDays.set(day, parts.flat());
        fetchedAt.set(key, Date.now());
        failedAt.delete(key);
        bump.update((n) => n + 1);
      })
      .catch(() => failedAt.set(key, Date.now()))
      .finally(() => inflight.delete(key));
  }

  function ensure(from: number, to: number) {
    const list = localDaysBetween(from, to);
    const all = [addDays(list[0], -1), ...list, addDays(list[list.length - 1], 1)];
    for (const day of all) {
      const key = `e|${day}`;
      if (!days.has(day) && retryable(key)) {
        days.add(day);
        daysAsked.update((n) => n + 1);
        loadDay(cam, day, { fetch }).catch(() => {
          days.delete(day);
          failedAt.set(key, Date.now());
        });
      }
      loadPreviews(day);
    }
  }

  function ensureStills(t: number) {
    if (!proxy) return;
    const h0 = Math.floor(t / HOUR) * HOUR;
    for (const h of [h0, h0 + HOUR]) {
      const key = `s|${h}`;
      if (inflight.has(key) || current(key, h + HOUR > Date.now()) || !retryable(key)) continue;
      inflight.add(key);
      fetch<number[]>(`/api/cameras/${enc}/stills?from=${h}&to=${h + HOUR - 1}`)
        .then((ts) => {
          if (!alive) return;
          stillHours.set(h, stillRuns(ts));
          fetchedAt.set(key, Date.now());
          failedAt.delete(key);
          bump.update((n) => n + 1);
        })
        .catch(() => failedAt.set(key, Date.now()))
        .finally(() => inflight.delete(key));
    }
  }

  const events = derived([dayStore, daysAsked], ([m]) => {
    const out: EventClip[] = [];
    for (const day of days) out.push(...(m.get(`${cam}|${day}`)?.events ?? []));
    return out;
  });
  const previews = derived(bump, () => [...previewDays.values()].flat().sort((a, b) => a.minute - b.minute));
  const coverage = derived([events, failed, bump], ([evs, f]) => ({
    clips: clipRuns(evs, f),
    stills: mergeRuns([...stillHours.values()].flat(), 2000),
    previews: previewRuns([...previewDays.values()].flat()),
  }));

  return {
    coverage: { subscribe: (fn) => (alive ? coverage.subscribe(fn) : (fn(EMPTY_COVERAGE), () => undefined)) },
    events,
    previews,
    ensure,
    ensureStills,
    markFailed: (id) => failed.update((s) => new Set(s).add(id)),
    eventsOn: (day) => get(dayStore).get(`${cam}|${day}`)?.events ?? null,
    destroy: () => {
      alive = false;
    },
  };
}

export { localDate };
