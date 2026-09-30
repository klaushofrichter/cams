import { EventEmitter } from 'events';
import { listProxied } from '../cameraRegistry';
import { logger } from '../logger';
import { getProxyClient, ProxyError, type ProxyClient, proxyCameraId } from './client';

// One upstream subscription to a camera's cam-proxy event stream (SSE).
// It resumes from the last id after a drop, starts over on `reset`, and
// reconnects with backoff while the proxy is away. Emits:
//   'message' {cam, type, data}   (type 'reset' when the proxy lost our place)
//   'state'   up (boolean)

export interface StreamOptions {
  backoffMinMs?: number;
  backoffMaxMs?: number;
  healthyMs?: number; // connected this long: the backoff starts over
  idleMs?: number; // nothing received this long (cam-proxy pings every 15 s): reconnect
  remoteCam?: string; // the proxy's id for this camera: messages for others are dropped
}

// A proxy from before the `analysis` stream type existed (v2026.09.30.3 and
// older) answers 400 to it, and the stream asks again without it.
const TYPES = ['camera-event', 'camera-status', 'clip', 'analysis'];

export class ProxyStream extends EventEmitter {
  private lastId: string | undefined;
  private isUp = false;
  private stopped = true;
  private abort: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;
  private delay: number;
  private error: string | null = null;
  private types = [...TYPES];

  constructor(
    readonly cam: string,
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

  private setUp(up: boolean): void {
    if (up === this.isUp) return;
    this.isUp = up;
    this.emit('state', up);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const abort = new AbortController();
    this.abort = abort;
    const connectedAt = Date.now();
    try {
      const res = await this.client.open('/api/stream', { types: this.types.join(','), since: this.lastId }, { signal: abort.signal, idleMs: this.o.idleMs ?? 45_000 });
      if (!res.ok || !res.body) {
        let text = '';
        if (res.status === 400) text = await res.text().catch(() => '');
        else await res.body?.cancel();
        if (this.types.includes('analysis') && /unknown type: analysis/.test(text)) {
          this.types = this.types.filter((t) => t !== 'analysis');
          logger.debug({ cameraId: this.cam }, 'proxy_stream_without_analysis');
          return void this.connect();
        }
        throw new ProxyError('proxy_error', `cam-proxy ${this.client.host()} stream answered ${res.status}`, res.status);
      }
      this.error = null;
      this.setUp(true);
      await this.read(res.body);
      throw new ProxyError('proxy_unreachable', `cam-proxy ${this.client.host()} ended the stream`);
    } catch (err) {
      if (this.stopped) return;
      const code = err instanceof ProxyError ? err.code : 'proxy_unreachable';
      if (code !== this.error) logger.warn({ cameraId: this.cam, code, message: (err as Error).message }, 'proxy_stream_down');
      this.error = code;
      this.setUp(false);
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
      this.emit('message', { cam: this.cam, type: 'reset', data: {} });
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
    // A proxy can serve several cameras: pass on only this camera's messages.
    if (typeof parsed.cam === 'string' && parsed.cam !== (this.o.remoteCam ?? this.cam)) return;
    this.emit('message', { cam: this.cam, type: event, data: parsed });
  }
}

// All cameras' streams, for the browser relay (routes/events.ts).
export const proxyHub = new EventEmitter();
proxyHub.setMaxListeners(0);
const streams = new Map<string, ProxyStream>();

let options: StreamOptions = {};
let shuttingDown = false; // set by stopProxyStreams(true) at SIGTERM

export function startProxyStreams(o: StreamOptions = {}): void {
  stopProxyStreams();
  shuttingDown = false;
  options = o;
  for (const cam of listProxied()) startProxyStream(cam);
}

// One camera's stream, e.g. after its proxy is switched back on.
export function startProxyStream(cam: string): void {
  if (shuttingDown || streams.has(cam)) return;
  const client = getProxyClient(cam);
  if (!client) return;
  const s = new ProxyStream(cam, client, { ...options, remoteCam: proxyCameraId(cam) });
  s.on('message', (m) => proxyHub.emit('message', m));
  s.on('state', (up: boolean) => proxyHub.emit('state', { cam, up }));
  streams.set(cam, s);
  s.start();
}

// One camera's stream, when its proxy is switched off. Browsers hear that the
// proxy is gone and reload that camera's events from the camera.
export function stopProxyStream(cam: string): void {
  const s = streams.get(cam);
  if (!s) return;
  const wasUp = s.up(); // an up stream reports its own end when stopped
  s.stop();
  streams.delete(cam);
  if (!wasUp) proxyHub.emit('state', { cam, up: false });
}

// `final`: the process is shutting down, and no stream may start again.
export function stopProxyStreams(final = false): void {
  if (final) shuttingDown = true;
  for (const s of streams.values()) s.stop();
  streams.clear();
}

export function proxyStates(): { cam: string; up: boolean }[] {
  return [...streams.values()].map((s) => ({ cam: s.cam, up: s.up() }));
}

export function proxyUp(cam: string): boolean {
  return streams.get(cam)?.up() ?? false;
}
