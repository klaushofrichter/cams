import { get, writable, type Readable } from 'svelte/store';
import { cameras, type CameraSummary } from './stores';
import { getJson } from './api';
import { preferences } from './preferences';

// cams' relay of the cameras' cam-proxy events (GET /api/events/stream,
// Plan 6). While a camera's proxy is up, pages reload on its changes at once
// instead of polling; when the stream or the proxy is down they poll as
// before. EventSource reconnects by itself (cams restarting, Knative's
// 600-second cut).

export interface EventSourceLike {
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, fn: (e: { data: string }) => void): void;
  close(): void;
}

export interface Change {
  cam: string;
  type: string;
  ts: number | null;
  kind?: string; // camera events: person, vehicle, pet, motion, …
  phase?: 'start' | 'end';
}

// A camera event that just started (the live notification, Klaus 2026-09-28).
export interface CameraEvent {
  cam: string;
  kind: string;
  ts: number;
}

export interface EventStream {
  state: Readable<{ connected: boolean; up: Record<string, boolean> }>;
  streaming(cam: string): boolean;
  // Calls onChange (debounced) after changes for the camera cam() names.
  watch(cam: () => string, onChange: () => void, debounceMs?: number): () => void;
  onCameraEvent(fn: (e: CameraEvent) => void): () => void;
  close(): void;
}

const parse = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
};

const REOPEN_MIN_MS = 5_000;
const REOPEN_MAX_MS = 60_000;
// A recording still being written when its event ends isn't listed yet.
const AFTER_EVENT_MS = 60_000;

// A camera's proxy was switched on or off (Settings, any user): re-read the list.
const reloadCameras = () =>
  void getJson<CameraSummary[]>('/api/cameras')
    .then((list) => cameras.set(list))
    .catch(() => undefined);

export function createEventStream(opts: { url?: string; factory?: (url: string) => EventSourceLike; onCameras?: () => void } = {}): EventStream {
  const url = opts.url ?? '/api/events/stream';
  const factory = opts.factory ?? ((u) => new EventSource(u) as unknown as EventSourceLike);
  const state = writable<{ connected: boolean; up: Record<string, boolean> }>({ connected: false, up: {} });
  const watchers = new Set<{ cam: () => string; fire: (after?: number) => void }>();
  const eventListeners = new Set<(e: CameraEvent) => void>();
  let source: EventSourceLike;
  let missed = false; // disconnected since the last open: pages reload once back
  let reopenMs = REOPEN_MIN_MS;
  let reopenTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const open = () => {
    source = factory(url);
    source.onopen = () => {
      state.update((s) => ({ ...s, connected: true }));
      reopenMs = REOPEN_MIN_MS;
      if (missed) for (const w of watchers) w.fire();
      missed = false;
    };
    // The server repeats every camera's state on reconnect.
    source.onerror = () => {
      state.set({ connected: false, up: {} });
      missed = true;
      // A non-200 answer (session expired, rate limit, too many streams, a
      // rollout) closes an EventSource for good: open a new one later.
      if (source.readyState === 2 && !closed) {
        source.close();
        reopenTimer = setTimeout(open, reopenMs);
        reopenMs = Math.min(reopenMs * 2, REOPEN_MAX_MS);
      }
    };
    source.addEventListener('proxy', (e) => {
      const p = parse(e.data) as { cam?: unknown; up?: unknown } | undefined;
      if (!p || typeof p.cam !== 'string' || typeof p.up !== 'boolean') return;
      state.update((s) => ({ ...s, up: { ...s.up, [p.cam as string]: p.up as boolean } }));
    });
    source.addEventListener('cameras', () => (opts.onCameras ?? reloadCameras)());
    source.addEventListener('change', (e) => {
      const c = parse(e.data) as Change | undefined;
      if (!c || typeof c.cam !== 'string') return;
      if (c.type === 'camera-event' && c.phase === 'start' && typeof c.kind === 'string' && typeof c.ts === 'number') {
        for (const fn of eventListeners) fn({ cam: c.cam, kind: c.kind, ts: c.ts });
      }
      for (const w of watchers) {
        if (c.cam !== w.cam()) continue;
        w.fire();
        if (c.type === 'camera-event') w.fire(AFTER_EVENT_MS);
      }
    });
  };
  open();

  return {
    state,
    streaming(cam) {
      const s = get(state);
      return s.connected && s.up[cam] === true;
    },
    watch(cam, onChange, debounceMs = 1000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let later: ReturnType<typeof setTimeout> | undefined;
      const w = {
        cam,
        fire(after?: number) {
          if (after) {
            clearTimeout(later);
            later = setTimeout(onChange, after);
            return;
          }
          clearTimeout(timer);
          timer = setTimeout(onChange, debounceMs);
        },
      };
      watchers.add(w);
      return () => {
        clearTimeout(timer);
        clearTimeout(later);
        watchers.delete(w);
      };
    },
    onCameraEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    close() {
      closed = true;
      clearTimeout(reopenTimer);
      state.set({ connected: false, up: {} }); // a closed stream streams nothing: pages poll
      source.close();
      watchers.clear();
      eventListeners.clear();
    },
  };
}

// The app's one stream, opened when a camera has a cam-proxy (even one
// switched off, so the page hears when it is switched on again), unless live
// events are off in Settings: then pages poll as before.
let shared: EventStream | undefined;
export function closeEventStream(): void {
  shared?.close();
  shared = undefined;
}
export function eventStream(): EventStream | undefined {
  if (get(preferences)?.liveEvents === false) {
    closeEventStream();
    return undefined;
  }
  if (shared) return shared;
  if (!get(cameras).some((c) => c.proxyConfigured ?? c.proxy) || typeof EventSource === 'undefined') return undefined;
  shared = createEventStream();
  return shared;
}

// Live events wait for their recording (Klaus, 2026-09-28): one is dropped
// once a listed recording covers it (or starts within 90 s after it), or after
// 15 minutes.
export interface Pending {
  kind: string;
  ts: number;
}
export function prunePending(pending: Pending[], events: { start: string; end: string }[], now: number): Pending[] {
  const spans = events.map((e) => [Date.parse(e.start), Date.parse(e.end)] as const);
  // Covered: the recording starts up to 90 s after the event, or the event
  // falls inside it (a recording the camera extended).
  return pending.filter((p) => now - p.ts < 15 * 60_000 && !spans.some(([s, e]) => p.ts >= s - 90_000 && p.ts <= e + 5_000));
}

// One row per recording in progress (Klaus, 2026-09-30). The camera extends
// a recording while events keep coming, and clips don't run side by side
// (a new one only repeats the last ~4 s, its pre-record). On cam1 (24 h, 96
// events) events of one clip were at most 25 s apart, events of consecutive
// clips at least 22 s: an event at most 20 s after the previous one joins its
// recording. Newest group first; each kind once, AI kinds first.
export const PENDING_GROUP_MS = 20_000;
const KIND_ORDER = ['person', 'vehicle', 'pet', 'motion'];
export interface PendingGroup {
  start: number; // the first event
  ts: number; // the latest event
  kinds: string[];
}
export function groupPending(pending: Pending[]): PendingGroup[] {
  const groups: PendingGroup[] = [];
  for (const p of [...pending].sort((a, b) => a.ts - b.ts)) {
    const g = groups[groups.length - 1];
    if (g && p.ts - g.ts <= PENDING_GROUP_MS) {
      g.ts = p.ts;
      if (!g.kinds.includes(p.kind)) g.kinds.push(p.kind);
    } else groups.push({ start: p.ts, ts: p.ts, kinds: [p.kind] });
  }
  const rank = (k: string) => {
    const i = KIND_ORDER.indexOf(k);
    return i < 0 ? KIND_ORDER.length : i;
  };
  for (const g of groups) g.kinds.sort((a, b) => rank(a) - rank(b));
  return groups.reverse();
}
