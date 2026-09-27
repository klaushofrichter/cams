import { getCamera } from '../cameraRegistry';

// Talks to a camera's cam-proxy with its client token (Bearer). The token
// never leaves the server: errors and logs name the proxy's host only.

export type ProxyErrorCode = 'proxy_unreachable' | 'proxy_unauthorized' | 'proxy_error';

export class ProxyError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
    readonly status?: number,
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

  private urlOf(path: string, query?: Query): URL {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  }

  // The upstream response, whatever its status, for streaming (images, clip
  // files, the event stream). A refused token and a dead proxy still throw.
  async open(path: string, query?: Query, init: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number | null } = {}): Promise<Response> {
    const timeout = init.timeoutMs === null ? undefined : AbortSignal.timeout(init.timeoutMs ?? this.o.timeoutMs ?? 10_000);
    const signal = timeout && init.signal ? AbortSignal.any([timeout, init.signal]) : (timeout ?? init.signal);
    let res: Response;
    try {
      res = await fetch(this.urlOf(path, query), { headers: { ...init.headers, Authorization: `Bearer ${this.p.token}` }, signal, redirect: 'error' });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new ProxyError('proxy_unreachable', `cam-proxy ${this.host()} unreachable (${(err as Error).name})`);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new ProxyError('proxy_unauthorized', `cam-proxy ${this.host()} refused the token (${res.status})`, res.status);
    }
    return res;
  }

  async json<T>(path: string, query?: Query): Promise<T> {
    const res = await this.open(path, query);
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProxyError('proxy_error', `cam-proxy ${this.host()} answered ${res.status}`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProxyError('proxy_error', `cam-proxy ${this.host()} sent a body that isn't JSON`, res.status);
    }
  }
}

// One client per camera for the life of the process (like reolink/clients).
const clients = new Map<string, ProxyClient>();

export function getProxyClient(id: string): ProxyClient | undefined {
  const existing = clients.get(id);
  if (existing) return existing;
  const proxy = getCamera(id)?.proxy;
  if (!proxy) return undefined;
  const client = new ProxyClient(proxy);
  clients.set(id, client);
  return client;
}

// The proxy's id for a camera: `proxy.camera`, or else ours.
export function proxyCameraId(id: string): string {
  return getCamera(id)?.proxy?.camera ?? id;
}

export function resetProxyClients(): void {
  clients.clear();
}
