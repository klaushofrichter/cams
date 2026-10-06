import type { Dispatcher } from 'undici';
import { getCamera } from '../cameraRegistry';
import { proxyEnabled } from '../proxyState';
import { groupDispatcher, groupTlsFailed } from '../tls/groupCa';
import { fetchWith, SiteCaError } from '../tls/siteCa';
import { groupOf, type ProxyGroup } from './groups';

// Talks to a camera's cam-proxy with its client token (Bearer). The token
// never leaves the server: errors and logs name the proxy's host only.

export type ProxyErrorCode = 'proxy_unreachable' | 'proxy_unauthorized' | 'proxy_error';

export class ProxyError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
    readonly status?: number,
    readonly upstream?: string, // the proxy's own `error` code, when it sent one
    readonly reason?: string, // its `reason` (a 502 recordings_unavailable says why), when it sent one
    readonly retryAfterS?: number, // its Retry-After in seconds (a 503 busy), when it sent one
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

type Query = Record<string, string | number | undefined>;

export interface ProxyClientOptions {
  timeoutMs?: number;
  // A site-CA proxy (spec 2026-10-05 §12.3): the dispatcher that trusts only
  // its pinned CA, and what to do when its certificate stops verifying.
  dispatcher?: () => Promise<Dispatcher | undefined>;
  onTlsError?: () => void;
}

const tlsFailure = (err: unknown): boolean => /CERT|ERR_TLS_|SIGNATURE|UNABLE_TO|ALTNAME|SUBTREE|^UNSPECIFIED$/.test(String((err as { cause?: { code?: unknown } }).cause?.code ?? ''));

export class ProxyClient {
  private readonly base: URL;

  constructor(
    private readonly p: { url: string; token: string },
    private readonly o: ProxyClientOptions = {},
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
    init: { method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number | null; idleMs?: number } = {},
  ): Promise<Response> {
    init.signal?.throwIfAborted(); // an already-aborted signal never fires its listener
    let dispatcher: Dispatcher | undefined;
    try {
      dispatcher = await this.o.dispatcher?.();
    } catch (err) {
      throw new ProxyError('proxy_unreachable', `cam-proxy ${this.host()}: ${err instanceof SiteCaError ? err.message.replace(/^cam-proxy [^:]+: /, '') : 'its site CA is not verified'}`);
    }
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', onAbort, { once: true });
    const ms = init.timeoutMs === null ? undefined : (init.timeoutMs ?? this.o.timeoutMs ?? 10_000);
    const headerTimer = ms === undefined ? undefined : setTimeout(() => ctl.abort(new Error('timeout')), ms);
    let res: Response;
    try {
      res = await fetchWith(dispatcher)(this.urlOf(path, query), {
        method: init.method ?? 'GET',
        body: init.body,
        headers: { ...init.headers, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${this.p.token}` },
        signal: ctl.signal,
        redirect: 'error',
      });
    } catch (err) {
      init.signal?.removeEventListener('abort', onAbort);
      if (init.signal?.aborted) throw err;
      if (dispatcher && tlsFailure(err)) this.o.onTlsError?.();
      throw new ProxyError('proxy_unreachable', `cam-proxy ${this.host()} unreachable (${(err as Error).name})`);
    } finally {
      clearTimeout(headerTimer);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new ProxyError('proxy_unauthorized', `cam-proxy ${this.host()} refused the token (${res.status})`, res.status);
    }
    if (!init.idleMs || !res.body) return res;
    // A watchdog on the body: every chunk re-arms it. It ends when the body
    // ends or is aborted, and never holds the process by itself (unref; a
    // reader that cancels leaves at most a harmless late abort): an aborted
    // event stream's watchdog kept cams alive for up to idleMs after SIGTERM
    // (issue #216).
    const idle = init.idleMs;
    let timer: NodeJS.Timeout | undefined;
    let over = false;
    const disarm = () => {
      over = true;
      clearTimeout(timer);
    };
    const arm = () => {
      clearTimeout(timer);
      if (over) return;
      timer = setTimeout(() => ctl.abort(new Error('stalled')), idle);
      timer.unref();
    };
    ctl.signal.addEventListener('abort', disarm, { once: true });
    arm();
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          arm();
          c.enqueue(chunk);
        },
        flush: disarm,
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  async json<T>(path: string, query?: Query, init: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const res = await this.open(path, query, init);
    if (!res.ok) {
      const { error: upstream, reason } = await errorBody(res);
      const ra = res.headers.get('retry-after');
      throw new ProxyError('proxy_error', `cam-proxy ${this.host()} answered ${res.status}`, res.status, upstream, reason, ra && /^\d{1,6}$/.test(ra) ? Number(ra) : undefined);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProxyError('proxy_error', `cam-proxy ${this.host()} sent a body that isn't JSON`, res.status);
    }
  }
}

// The proxy's `error` code and short `reason` from a refused request's body:
// its first 4 KB, within a second (a stalled body must not hang the route),
// then dropped.
export async function errorBody(res: Response): Promise<{ error?: string; reason?: string }> {
  if (!res.body) return {};
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
    return {};
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown; reason?: unknown } | null;
    return {
      error: typeof body?.error === 'string' ? body.error.slice(0, 64) : undefined,
      reason: typeof body?.reason === 'string' ? body.reason.slice(0, 64) : undefined,
    };
  } catch {
    return {};
  }
}

// One client per cam-proxy (group: url + token) for the life of the process.
const clients = new Map<string, ProxyClient>();

// The group's client whether or not the camera's proxy is switched on (the
// Settings page's proxy info asks even then).
export function proxyClientFor(id: string): ProxyClient | undefined {
  const g = groupOf(id);
  if (!g) return undefined;
  let client = clients.get(g.key);
  if (!client) clients.set(g.key, (client = new ProxyClient({ url: g.url, token: g.token }, trustOf(g))));
  return client;
}

const trustOf = (g: ProxyGroup): Pick<ProxyClientOptions, 'dispatcher' | 'onTlsError'> =>
  g.pins ? { dispatcher: () => groupDispatcher(g), onTlsError: () => groupTlsFailed(g) } : {};

// For another client of the same proxy (the admin token's): the same trust.
export function groupTrustOptions(id: string): Pick<ProxyClientOptions, 'dispatcher' | 'onTlsError'> {
  const g = groupOf(id);
  return g ? trustOf(g) : {};
}

// Undefined for a camera without a cam-proxy or with it switched off.
export function getProxyClient(id: string): ProxyClient | undefined {
  return proxyEnabled(id) ? proxyClientFor(id) : undefined;
}

// The proxy's id for a camera: `proxy.camera`, or else ours.
// Taken from the configuration, never from the request.
export function proxyCameraId(id: string): string {
  const camera = getCamera(id);
  if (!camera) throw new Error('unknown camera');
  return camera.proxy?.camera ?? camera.id;
}

// The client for a camera whose cam-proxy is in use. The proxy can be
// switched off between two calls: then proxy_unreachable.
export function requireProxyClient(id: string): ProxyClient {
  const client = getProxyClient(id);
  if (!client) throw new ProxyError('proxy_unreachable', 'the camera has no cam-proxy in use');
  return client;
}

// A path of the proxy's API for one of its cameras (`rest` starts with "/").
export function proxyPath(id: string, rest: string): string {
  return `/api/cameras/${encodeURIComponent(proxyCameraId(id))}${rest}`;
}

export function resetProxyClients(): void {
  clients.clear();
}
