import { get, writable, type Readable } from 'svelte/store';
import { cameras, type CameraSummary } from './stores';
import { getJson } from './api';

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
}

export interface EventStream {
  state: Readable<{ connected: boolean; up: Record<string, boolean> }>;
  streaming(cam: string): boolean;
  // Calls onChange (debounced) after changes for the camera cam() names.
  watch(cam: () => string, onChange: () => void, debounceMs?: number): () => void;
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
    close() {
      closed = true;
      clearTimeout(reopenTimer);
      source.close();
      watchers.clear();
    },
  };
}

// The app's one stream, opened when a camera has a cam-proxy (even one
// switched off, so the page hears when it is switched on again).
let shared: EventStream | undefined;
export function eventStream(): EventStream | undefined {
  if (shared) return shared;
  if (!get(cameras).some((c) => c.proxyConfigured ?? c.proxy) || typeof EventSource === 'undefined') return undefined;
  shared = createEventStream();
  return shared;
}
