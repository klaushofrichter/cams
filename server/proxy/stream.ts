import { EventEmitter } from 'events';
import { listProxied, proxyActive } from '../cameraRegistry';
import { logger } from '../logger';
import { getProxyClient, ProxyError, type ProxyClient } from './client';
import { supportsCamList } from './cameraList';
import { activeMembers, groupOf, proxyGroups, remoteIds, type ProxyGroup } from './groups';

// One upstream subscription to a cam-proxy's event stream (SSE), shared by
// every cams camera on that proxy (cam-proxy spec 2026-10-05 §12.2). It
// resumes from the last id after a drop, starts over on `reset`, and
// reconnects with backoff while the proxy is away. Emits:
//   'message' {remote, type, data}   remote: the message's `cam` (the proxy's id), null when it has none; type 'reset' when the proxy lost our place
//   'state'   up (boolean)

export interface StreamOptions {
  backoffMinMs?: number;
  backoffMaxMs?: number;
  healthyMs?: number; // connected this long: the backoff starts over
  idleMs?: number; // nothing received this long (cam-proxy pings every 15 s): reconnect
  cams?: () => string[] | Promise<string[]>; // the proxy's camera ids to ask for (?cam=a,b), read at every connect; empty: all (filtered by the caller)
}

// A proxy from before the `analysis` stream type existed (v2026.09.30.3 and
// older) answers 400 to it, and the stream asks again without it (until the
// next reconnect, which tries it again). The same for `camera` (the camera's
// name, {cam, name}; design camera-name-design.md), newer still, and for
// `still-check` (Vision on a second picked by hand, cams #179), and for
// `archive` (the Archive changed, cam-proxy's archive contract §7).
const TYPES = ['camera-event', 'camera-status', 'clip', 'analysis', 'camera', 'still-check', 'archive'];
const OPTIONAL = ['analysis', 'camera', 'still-check', 'archive'];

export class ProxyStream extends EventEmitter {
  private lastId: string | undefined;
  private isUp = false;
  private stopped = true;
  private abort: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;
  private delay: number;
  private error: string | null = null;
  private types = [...TYPES];
  private gen = 0;

  constructor(
    readonly label: string,
    private readonly client: ProxyClient,
    private readonly o: StreamOptions = {},
  ) {
    super();
    this.delay = o.backoffMinMs ?? 1000;
  }

  up(): boolean {
    return this.isUp;
  }

  lastError(): string | null {
    return this.error;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort?.abort();
    this.setUp(false);
  }

  // The camera list changed (a camera switched on or off): ask again at
  // once, from the last id, without reporting down in between.
  reconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.delay = this.o.backoffMinMs ?? 1000;
    this.abort?.abort();
    void this.connect();
  }

  private setUp(up: boolean): void {
    if (up === this.isUp) return;
    this.isUp = up;
    this.emit('state', up);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.gen;
    const abort = new AbortController();
    this.abort = abort;
    const connectedAt = Date.now();
    try {
      const cams = (await this.o.cams?.()) ?? [];
      if (this.stopped || gen !== this.gen) return; // stopped or re-subscribed while the list was read
      const res = await this.client.open('/api/stream', { types: this.types.join(','), since: this.lastId, cam: cams.length ? cams.join(',') : undefined }, { signal: abort.signal, idleMs: this.o.idleMs ?? 45_000 });
      if (!res.ok || !res.body) {
        let text = '';
        if (res.status === 400) text = await res.text().catch(() => '');
        else await res.body?.cancel();
        const unknown = /unknown type: ([a-z-]+)/.exec(text)?.[1];
        if (unknown && OPTIONAL.includes(unknown) && this.types.includes(unknown)) {
          this.types = this.types.filter((t) => t !== unknown);
          logger.debug({ proxy: this.label, type: unknown }, 'proxy_stream_without_type');
          return void this.connect();
        }
        throw new ProxyError('proxy_error', `cam-proxy ${this.client.host()} stream answered ${res.status}`, res.status);
      }
      this.error = null;
      this.setUp(true);
      await this.read(res.body);
      throw new ProxyError('proxy_unreachable', `cam-proxy ${this.client.host()} ended the stream`);
    } catch (err) {
      if (this.stopped || gen !== this.gen) return;
      const code = err instanceof ProxyError ? err.code : 'proxy_unreachable';
      if (code !== this.error) logger.warn({ proxy: this.label, code, message: (err as Error).message }, 'proxy_stream_down');
      this.error = code;
      this.setUp(false);
      // The proxy may come back as a newer version: ask for every type again.
      this.types = [...TYPES];
      if (Date.now() - connectedAt >= (this.o.healthyMs ?? 60_000)) this.delay = this.o.backoffMinMs ?? 1000;
      // A refused token won't fix itself soon: retry at the slowest pace.
      const wait = code === 'proxy_unauthorized' ? (this.o.backoffMaxMs ?? 30_000) : this.delay;
      this.delay = Math.min(this.delay * 2, this.o.backoffMaxMs ?? 30_000);
      this.timer = setTimeout(() => void this.connect(), wait);
    }
  }

  // SSE frames: blank-line separated, `id:`, `event:`, `data:` lines.
  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(buf[i] === '\r' ? i + 4 : i + 2);
        this.frame(frame);
      }
      if (buf.length > 1_000_000) throw new ProxyError('proxy_error', `cam-proxy ${this.client.host()} sent an oversized frame`);
    }
  }

  private frame(frame: string): void {
    let id: string | undefined;
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const k = line.indexOf(':');
      const field = k < 0 ? line : line.slice(0, k);
      const value = k < 0 ? '' : line.slice(k + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (event === 'reset') {
      this.lastId = undefined;
      this.emit('message', { remote: null, type: 'reset', data: {} });
      return;
    }
    if (!data.length) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.join('\n')) as Record<string, unknown>;
    } catch {
      return;
    }
    if (id !== undefined) this.lastId = id;
    this.emit('message', { remote: typeof parsed.cam === 'string' ? parsed.cam : null, type: event, data: parsed });
  }
}

// Every cams camera's messages and states, for the browser relay
// (routes/events.ts), the names and the recordings cache: per cams camera.
export const proxyHub = new EventEmitter();
proxyHub.setMaxListeners(0);

interface Running {
  group: ProxyGroup;
  stream: ProxyStream;
  members: string[]; // the cams cameras it serves now (switched on), config order
  joined: Map<string, number>; // a camera switched back on → when (its replay is dropped)
}
const running = new Map<string, Running>(); // by group key

let options: StreamOptions = {};
let shuttingDown = false; // set by stopProxyStreams(true) at SIGTERM

const camList = (r: Running) => remoteIds(r.group, r.members).join(',');

// A camera that joins a running stream gets the stream's replay from its
// last id, which may be hours old on a quiet proxy: its own messages from
// before it joined are dropped (they'd show as new notices). Timed by the
// message's own time, with some slack for the two clocks; for a minute.
const JOIN_SLACK_MS = 5000;
const JOIN_WINDOW_MS = 60_000;
const timeOf = (d: Record<string, unknown>): number | undefined => [d.ts, d.start, d.stillTs].find((v): v is number => typeof v === 'number');

function stale(r: Running, cam: string, m: { type: string; data: Record<string, unknown> }): boolean {
  const at = r.joined.get(cam);
  if (at === undefined || m.type === 'reset') return false;
  if (Date.now() - at > JOIN_WINDOW_MS) {
    r.joined.delete(cam);
    return false;
  }
  const t = timeOf(m.data);
  return t !== undefined && t < at - JOIN_SLACK_MS;
}

function fanOut(r: Running, m: { remote: string | null; type: string; data: Record<string, unknown> }): void {
  const to = m.type === 'reset' || m.remote === null ? r.members : r.members.filter((id) => r.group.remoteOf.get(id) === m.remote);
  for (const cam of to) if (!stale(r, cam, m)) proxyHub.emit('message', { cam, type: m.type, data: m.data });
}

function run(group: ProxyGroup, members: string[]): void {
  const client = getProxyClient(members[0]);
  if (!client) return;
  const r: Running = { group, members, joined: new Map(), stream: undefined as unknown as ProxyStream };
  r.stream = new ProxyStream(client.host(), client, {
    ...options,
    // A list only to a proxy that takes it; one id works on every proxy;
    // several on an older proxy: no filter, fanOut drops what we don't map.
    cams: async () => {
      const ids = remoteIds(group, r.members);
      return ids.length > 1 && !(await supportsCamList(r.members[0])) ? [] : ids;
    },
  });
  r.stream.on('message', (m) => fanOut(r, m));
  r.stream.on('state', (up: boolean) => {
    for (const cam of r.members) proxyHub.emit('state', { cam, up });
  });
  running.set(group.key, r);
  r.stream.start();
}

export function startProxyStreams(o: StreamOptions = {}): void {
  stopProxyStreams();
  shuttingDown = false;
  options = o;
  for (const g of proxyGroups()) {
    const members = activeMembers(g);
    if (members.length) run(g, members);
  }
}

// One camera's proxy switched back on: it joins its proxy's stream (opened
// if it was the only one).
export function startProxyStream(cam: string): void {
  if (shuttingDown || !proxyActive(cam)) return;
  const g = groupOf(cam);
  if (!g) return;
  const r = running.get(g.key);
  if (!r) return run(g, [cam]);
  if (r.members.includes(cam)) return;
  const before = camList(r);
  r.members = activeMembers(g).filter((id) => id === cam || r.members.includes(id));
  r.joined.set(cam, Date.now());
  if (r.stream.up()) proxyHub.emit('state', { cam, up: true });
  if (camList(r) !== before) r.stream.reconnect();
}

// One camera's proxy switched off: it leaves the stream (closed with the
// last one). Browsers hear that its proxy is gone and reload its events
// from the camera.
export function stopProxyStream(cam: string): void {
  const g = groupOf(cam);
  const r = g && running.get(g.key);
  if (!r || !r.members.includes(cam)) return;
  const before = camList(r);
  r.members = r.members.filter((id) => id !== cam);
  r.joined.delete(cam);
  proxyHub.emit('state', { cam, up: false });
  if (!r.members.length) {
    r.stream.removeAllListeners();
    r.stream.stop();
    running.delete(g!.key);
    return;
  }
  if (camList(r) !== before) r.stream.reconnect();
}

// `final`: the process is shutting down, and no stream may start again.
export function stopProxyStreams(final = false): void {
  if (final) shuttingDown = true;
  for (const r of running.values()) r.stream.stop();
  running.clear();
}

export function proxyStates(): { cam: string; up: boolean }[] {
  const up = new Map<string, boolean>();
  for (const r of running.values()) for (const cam of r.members) up.set(cam, r.stream.up());
  return listProxied().filter((cam) => up.has(cam)).map((cam) => ({ cam, up: up.get(cam)! }));
}
