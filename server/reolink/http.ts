import http, { IncomingMessage } from 'node:http';
import https from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { normalizeFingerprint } from '../tls/fingerprint';

// How a camera's certificate is checked (cam-proxy spec 2026-10-05 §12.3):
//   public:      today's check against public CAs and the camera's
//                tlsServername (cam1's Let's Encrypt certificate);
//                `ca` is a test seam only
//   site-ca:     only the pinned site CA(s) of the camera's proxy, against
//                its .internal name, or its address (the leaf's IP SAN)
//   pinned:      the SHA-256 of the leaf and nothing else: a camera that
//                refused the import (its factory certificate)
//   none:        unverified (today's https camera without a tlsServername)
//   unavailable: a site-CA camera before its CA was ever verified: refused
export type CameraTrust =
  | { kind: 'public'; servername: string; ca?: string | Buffer }
  | { kind: 'site-ca'; ca: string[]; servername?: string }
  | { kind: 'pinned'; fingerprint: string }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string };

export interface CameraTarget {
  protocol: 'https' | 'http';
  host: string; // "ip" or "ip:port"
  tlsServername?: string; // without `trust`: a public-CA check against this name
  trust?: CameraTrust;
}

export const trustOf = (t: CameraTarget): CameraTrust => t.trust ?? (t.tlsServername ? { kind: 'public', servername: t.tlsServername } : { kind: 'none' });

const tlsError = (code: string, message: string) => Object.assign(new Error(message), { code });

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

// The leaf pin is checked on the socket at secureConnect, before the request
// is written: Node skips checkServerIdentity when the chain doesn't verify
// (a self-signed certificate), so it can't carry this check.
export function pinnedConnection(fingerprint: string, timeoutMs: number): NonNullable<https.RequestOptions['createConnection']> {
  return (opts, oncreate) => {
    const host = String(opts.hostname ?? opts.host ?? '').replace(/^\[(.*)\]$/, '$1');
    const socket = tlsConnect({ host, port: Number(opts.port ?? 443), rejectUnauthorized: false });
    socket.setTimeout(timeoutMs, () => socket.destroy(new TimeoutError()));
    const onError = (err: Error) => oncreate(err, socket);
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.off('error', onError);
      socket.setTimeout(0);
      if (normalizeFingerprint(socket.getPeerCertificate().fingerprint256) === fingerprint) return oncreate(null, socket);
      socket.destroy();
      oncreate(tlsError('ERR_TLS_CERT_PIN_MISMATCH', 'camera certificate does not match its pinned fingerprint'), socket);
    });
    return undefined;
  };
}

export function tlsOptions(trust: CameraTrust, timeoutMs: number): https.RequestOptions {
  switch (trust.kind) {
    case 'public':
      return { servername: trust.servername, rejectUnauthorized: true, ...(trust.ca && { ca: trust.ca }) };
    case 'site-ca':
      return { ca: trust.ca, rejectUnauthorized: true, ...(trust.servername && { servername: trust.servername }) };
    case 'pinned':
      return { createConnection: pinnedConnection(trust.fingerprint, timeoutMs), agent: undefined };
    case 'none':
      return { rejectUnauthorized: false };
    case 'unavailable':
      throw tlsError('ERR_TLS_CA_UNVERIFIED', trust.reason);
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

// Whether a failed openRequest had already handed its whole request to the
// camera. A reset after that means the camera may have acted on it (a Reboot
// that went down before answering); a refused or timed-out connection means
// nothing was sent.
const WRITTEN = Symbol('requestWritten');
export function requestWasWritten(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { [WRITTEN]?: boolean })[WRITTEN] === true;
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
  let tls: https.RequestOptions = {};
  if (target.protocol === 'https') {
    try {
      tls = tlsOptions(trustOf(target), opts.timeoutMs);
    } catch (err) {
      return Promise.reject(err);
    }
  }
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
    // 'finish' fires once the last byte is flushed to the socket, which a
    // connection that never opens doesn't reach.
    let written = false;
    req.on('finish', () => (written = true));
    req.setTimeout(opts.timeoutMs, () => req.destroy(new TimeoutError()));
    req.on('error', (err) => {
      if (written && typeof err === 'object' && err !== null) Object.assign(err, { [WRITTEN]: true });
      reject(err);
    });
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
