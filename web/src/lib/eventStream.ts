import { get, writable, type Readable } from 'svelte/store';
import { cameras } from './stores';

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

export function createEventStream(opts: { url?: string; factory?: (url: string) => EventSourceLike } = {}): EventStream {
  const url = opts.url ?? '/api/events/stream';
  const source = (opts.factory ?? ((u) => new EventSource(u) as unknown as EventSourceLike))(url);
  const state = writable<{ connected: boolean; up: Record<string, boolean> }>({ connected: false, up: {} });
  const watchers = new Set<(c: Change) => void>();

  source.onopen = () => state.update((s) => ({ ...s, connected: true }));
  // The server repeats every camera's state on reconnect.
  source.onerror = () => state.set({ connected: false, up: {} });
  source.addEventListener('proxy', (e) => {
    const p = parse(e.data) as { cam?: unknown; up?: unknown } | undefined;
    if (!p || typeof p.cam !== 'string' || typeof p.up !== 'boolean') return;
    state.update((s) => ({ ...s, up: { ...s.up, [p.cam as string]: p.up as boolean } }));
  });
  source.addEventListener('change', (e) => {
    const c = parse(e.data) as Change | undefined;
    if (!c || typeof c.cam !== 'string') return;
    for (const w of watchers) w(c);
  });

  return {
    state,
    streaming(cam) {
      const s = get(state);
      return s.connected && s.up[cam] === true;
    },
    watch(cam, onChange, debounceMs = 1000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const w = (c: Change) => {
        if (c.cam !== cam()) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, debounceMs);
      };
      watchers.add(w);
      return () => {
        clearTimeout(timer);
        watchers.delete(w);
      };
    },
    close() {
      source.close();
      watchers.clear();
    },
  };
}

// The app's one stream, opened when a camera has a cam-proxy.
let shared: EventStream | undefined;
export function eventStream(): EventStream | undefined {
  if (shared) return shared;
  if (!get(cameras).some((c) => c.proxy) || typeof EventSource === 'undefined') return undefined;
  shared = createEventStream();
  return shared;
}
