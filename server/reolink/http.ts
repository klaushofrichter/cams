import http, { IncomingMessage } from 'node:http';
import https from 'node:https';

export interface CameraTarget {
  protocol: 'https' | 'http';
  host: string; // "ip" or "ip:port"
  tlsServername?: string;
}

export interface OpenOptions {
  method?: 'GET' | 'POST';
  body?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export class TimeoutError extends Error {
  constructor() {
    super('camera did not respond in time');
    this.name = 'TimeoutError';
  }
}

// Distinguished from a network failure: the camera answered, but the body
// exceeded the configured limit. Callers map this to camera_error, not
// camera_offline.
export class ResponseTooLargeError extends Error {
  constructor() {
    super('camera response too large');
    this.name = 'ResponseTooLargeError';
  }
}

export function splitHost(host: string): { hostname: string; port?: number } {
  const i = host.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(host.slice(i + 1))) return { hostname: host.slice(0, i), port: Number(host.slice(i + 1)) };
  return { hostname: host };
}

// Plain node:http(s) rather than fetch: it gives an exact TLS name check
// (servername) for a camera reached by IP, and a raw stream for live video.
// timeoutMs is an inactivity timeout, so it also catches a stalled stream.
export function openRequest(target: CameraTarget, path: string, opts: OpenOptions): Promise<IncomingMessage> {
  const { hostname, port } = splitHost(target.host);
  const tls =
    target.protocol === 'https'
      ? { servername: target.tlsServername, rejectUnauthorized: Boolean(target.tlsServername) }
      : {};
  const lib = target.protocol === 'https' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname,
        port,
        path,
        method: opts.method ?? 'GET',
        signal: opts.signal,
        headers: opts.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(opts.body) } : {},
        ...tls,
      },
      (res) => {
        res.setTimeout(opts.timeoutMs, () => res.destroy(new TimeoutError()));
        resolve(res);
      },
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new TimeoutError()));
    req.on('error', reject);
    req.end(opts.body);
  });
}

export async function readBody(res: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      res.destroy();
      throw new ResponseTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
