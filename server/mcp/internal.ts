// A tool's call into cams's own /api (spec 2026-10-27-mcp-server-design §6,
// "Internal calls"): over loopback to the same port, with a secret made at
// process start and the token id. The route then runs as the token's
// principal (authState), so the role table, account isolation and every
// route's own checks apply unchanged. The secret never leaves this process.
import type { Request } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { Principal } from '../middleware/requireAuth';
import { mcpPrincipal } from './auth';
import { getMcpTokens } from './tokens';

export const INTERNAL_HEADER = 'x-cams-internal';
export const TOKEN_HEADER = 'x-cams-mcp-token';
const SECRET = randomBytes(32).toString('hex');

export interface InternalBase { host: string; port: number }

// The request names itself internal (it must then prove it; never a cookie).
export const isInternal = (req: Request): boolean => req.headers[INTERNAL_HEADER] !== undefined;

function secretOk(req: Request): boolean {
  const v = req.headers[INTERNAL_HEADER];
  if (typeof v !== 'string' || v.length !== SECRET.length) return false;
  return timingSafeEqual(Buffer.from(v), Buffer.from(SECRET));
}

// An internal request with the right secret (the per-address limits skip it).
export const isVerifiedInternal = (req: Request): boolean => isInternal(req) && secretOk(req);

export function internalPrincipal(req: Request): Principal | null {
  if (!secretOk(req)) return null;
  const id = req.headers[TOKEN_HEADER];
  const t = typeof id === 'string' ? getMcpTokens().byId(id) : null;
  return t ? mcpPrincipal(t) : null;
}

// Where this server is reached from inside: the address and port the MCP
// request came in on (an IPv4-mapped address as plain IPv4).
export function internalBaseOf(req: Request): InternalBase {
  const raw = req.socket.localAddress ?? '127.0.0.1';
  const host = raw.startsWith('::ffff:') ? raw.slice(7) : raw === '::' || raw === '0.0.0.0' ? '127.0.0.1' : raw;
  return { host, port: req.socket.localPort ?? Number(process.env.PORT ?? 8080) };
}

export function callApi(base: InternalBase, tokenId: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  if (!path.startsWith('/api/')) throw new Error('callApi: only /api paths');
  const host = base.host.includes(':') ? `[${base.host}]` : base.host;
  const headers: Record<string, string> = { ...init.headers, [INTERNAL_HEADER]: SECRET, [TOKEN_HEADER]: tokenId };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  return fetch(`http://${host}:${base.port}${path}`, { method: init.method ?? 'GET', headers, body, signal: init.signal ?? AbortSignal.timeout(120_000), redirect: 'manual' });
}
