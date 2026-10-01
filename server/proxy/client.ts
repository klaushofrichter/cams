import { getCamera } from '../cameraRegistry';
import { proxyEnabled } from '../proxyState';

// Talks to a camera's cam-proxy with its client token (Bearer). The token
// never leaves the server: errors and logs name the proxy's host only.

export type ProxyErrorCode = 'proxy_unreachable' | 'proxy_unauthorized' | 'proxy_error';

export class ProxyError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
    readonly status?: number,
    readonly upstream?: string, // the proxy's own `error` code, when it sent one
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

type Query = Record<string, string | number | undefined>;

export class ProxyClient {
  private readonly base: URL;

  constructor(
    private readonly p: { url: string; token: string },
    private readonly o: { timeoutMs?: number } = {},
  ) {
    this.base = new URL(p.url);
  }

  host(): string {
    return this.base.host;
  }

  // Under the proxy URL's own path, if it has one (issue #38: a leading
  // slash in `path` would otherwise drop it).
  private urlOf(path: string, query?: Query): URL {
    const u = new URL(`${this.base.pathname.replace(/\/+$/, '')}${path}`, this.base);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  }

  // The upstream response, whatever its status, for streaming (images, clip
  // files, the event stream). A refused token and a dead proxy still throw.
  // `timeoutMs` bounds the wait for the answer to start (null: none);
  // `idleMs` ends a body that stops arriving for that long (a large clip may
  // take minutes to stream, a stalled one must not hang forever).
  async open(
    path: string,
    query?: Query,
    init: { method?: 'GET' | 'POST' | 'DELETE'; body?: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number | null; idleMs?: number } = {},
  ): Promise<Response> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', onAbort, { once: true });
    const ms = init.timeoutMs === null ? undefined : (init.timeoutMs ?? this.o.timeoutMs ?? 10_000);
    const headerTimer = ms === undefined ? undefined : setTimeout(() => ctl.abort(new Error('timeout')), ms);
    let res: Response;
    try {
      res = await fetch(this.urlOf(path, query), {
        method: init.method ?? 'GET',
        body: init.body,
        headers: { ...init.headers, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${this.p.token}` },
        signal: ctl.signal,
        redirect: 'error',
      });
    } catch (err) {
      init.signal?.removeEventListener('abort', onAbort);
      if (init.signal?.aborted) throw err;
      throw new ProxyError('proxy_unreachable', `cam-proxy ${this.host()} unreachable (${(err as Error).name})`);
    } finally {
      clearTimeout(headerTimer);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new ProxyError('proxy_unauthorized', `cam-proxy ${this.host()} refused the token (${res.status})`, res.status);
    }
    if (!init.idleMs || !res.body) return res;
    // A watchdog on the body: every chunk re-arms it.
    const idle = init.idleMs;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(new Error('stalled')), idle);
    };
    arm();
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          arm();
          c.enqueue(chunk);
        },
        flush() {
          clearTimeout(timer);
        },
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  async json<T>(path: string, query?: Query, init: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const res = await this.open(path, query, init);
    if (!res.ok) {
      const upstream = await errorCode(res);
      throw new ProxyError('proxy_error', `cam-proxy ${this.host()} answered ${res.status}`, res.status, upstream);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProxyError('proxy_error', `cam-proxy ${this.host()} sent a body that isn't JSON`, res.status);
    }
  }
}

// The proxy's `error` code from a refused request's body: its first 4 KB,
// within a second (a stalled body must not hang the route), then dropped.
async function errorCode(res: Response): Promise<string | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), 1000);
  try {
    while (size < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown } | null;
    return typeof body?.error === 'string' ? body.error.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

// One client per camera for the life of the process (like reolink/clients).
const clients = new Map<string, ProxyClient>();

// Undefined for a camera without a cam-proxy or with it switched off.
export function getProxyClient(id: string): ProxyClient | undefined {
  if (!proxyEnabled(id)) return undefined;
  const existing = clients.get(id);
  if (existing) return existing;
  const proxy = getCamera(id)?.proxy;
  if (!proxy) return undefined;
  const client = new ProxyClient(proxy);
  clients.set(id, client);
  return client;
}

// The proxy's id for a camera: `proxy.camera`, or else ours.
// Taken from the configuration, never from the request.
export function proxyCameraId(id: string): string {
  const camera = getCamera(id);
  if (!camera) throw new Error('unknown camera');
  return camera.proxy?.camera ?? camera.id;
}

export function resetProxyClients(): void {
  clients.clear();
}
