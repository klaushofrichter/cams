// Video links (spec 2026-10-27-mcp-server-design §5): /mcp/media/<payload>.<sig>,
// HMAC-SHA256 with a key derived from COOKIE_SECRET, 15 minutes. A link
// carries the token id; its use re-checks the token and runs as it.
import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';
import type { ToolCtx } from './server';

export const LINK_TTL_MS = 15 * 60_000;
export type LinkKind = 'clip' | 'composition' | 'archive';
export interface LinkPayload { v: 1; tok: string; acc: string; cam: string; kind: LinkKind; ref: string; exp: number }

function key(): Buffer {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error('COOKIE_SECRET is not set');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'cams mcp media v1', 32));
}

const mac = (data: string) => createHmac('sha256', key()).update(data).digest('base64url');

export function signLink(p: Omit<LinkPayload, 'v'>): string {
  const data = Buffer.from(JSON.stringify({ v: 1, ...p })).toString('base64url');
  return `${data}.${mac(data)}`;
}

const KINDS: LinkKind[] = ['clip', 'composition', 'archive'];
export function verifyLink(s: string, now = Date.now()): LinkPayload | 'invalid' | 'expired' {
  const m = /^([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/.exec(s);
  if (!m) return 'invalid';
  const want = Buffer.from(mac(m[1]));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'invalid';
  let p: LinkPayload;
  try {
    p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as LinkPayload;
  } catch {
    return 'invalid';
  }
  if (p?.v !== 1 || typeof p.tok !== 'string' || typeof p.acc !== 'string' || typeof p.cam !== 'string' || typeof p.ref !== 'string' || !KINDS.includes(p.kind) || !Number.isSafeInteger(p.exp)) return 'invalid';
  return p.exp <= now ? 'expired' : p;
}

// The /api path a link's video comes from (the route checks everything again).
export function mediaPath(p: LinkPayload): string | null {
  const cam = encodeURIComponent(p.cam);
  if (p.kind === 'clip' && /^\d{8}-\d{6}-\d{6}$/.test(p.ref)) return `/api/cameras/${cam}/clips/${p.ref}/download?quality=sub`;
  if (p.kind === 'composition' && /^[A-Za-z0-9_-]{22}$/.test(p.ref)) return `/api/cameras/${cam}/compositions/${p.ref}/video?name=${cam}-clip.mp4`;
  if (p.kind === 'archive' && /^\d{1,12}$/.test(p.ref)) return `/api/archive/${cam}/items/${p.ref}/video?download=1`;
  return null;
}

export function linkFor(ctx: ToolCtx, p: { cam: string; kind: LinkKind; ref: string; exp?: number }): { url: string; expiresAtMs: number } {
  const exp = Math.min(p.exp ?? Infinity, Date.now() + LINK_TTL_MS);
  return { url: `${ctx.origin}/mcp/media/${signLink({ tok: ctx.token.id, acc: ctx.token.accountId, cam: p.cam, kind: p.kind, ref: p.ref, exp })}`, expiresAtMs: exp };
}
