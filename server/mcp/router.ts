// /mcp (spec 2026-10-27-mcp-server-design §6–§8): off unless enabled, POST
// only, the server's own Origin or none, a live bearer token, the limits, then
// a stateless Streamable HTTP transport with JSON answers. One audit line per
// request; never the token.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../logger';
import { bearerPrincipal, mcpPrincipal } from './auth';
import { mcpEnabled } from './config';
import { callApi, internalBaseOf } from './internal';
import { mediaPath, verifyLink } from './links';
import { limits } from './limits';
import { buildServer, makeCtx } from './server';
import { getMcpTokens } from './tokens';

export const MAX_BODY = 64 * 1024;
export const originOf = (req: Request): string => `${req.protocol}://${req.get('host')}`;

function tooMany(res: Response, retryAfter: number): void {
  res.set('Retry-After', String(retryAfter)).status(429).json({ error: 'rate_limited' });
}

// Shared with /mcp/media: off is a plain 404; a browser from another origin is refused.
export function mcpGate(req: Request, res: Response, next: NextFunction): void {
  if (!mcpEnabled()) return void res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'no-store');
  const origin = req.get('origin');
  if (origin !== undefined && origin !== originOf(req)) return void res.status(403).json({ error: 'cross-origin request rejected' });
  next();
}

export const mcpRouter = Router();

mcpRouter.all('/mcp', mcpGate, async (req: Request, res: Response) => {
  if (req.method !== 'POST') return void res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' });
  const addr = req.ip ?? 'unknown';
  const wait = limits.badBearer.peek(addr);
  if (wait) return tooMany(res, wait);
  const who = bearerPrincipal(req.get('authorization'));
  if (!who) {
    limits.badBearer.take(addr);
    logger.warn({ kind: 'mcp_auth_refused' }, 'mcp_auth_refused');
    return void res.set('WWW-Authenticate', 'Bearer error="invalid_token"').status(401).json({ error: 'unauthorized' });
  }
  if (Number(req.get('content-length') ?? 0) > MAX_BODY) return void res.status(413).json({ error: 'too_large' });
  // A JSON-RPC batch would run many calls for one count of the limits (and
  // one audit line); MCP dropped batches in 2025-06-18, so it is refused.
  if (Array.isArray(req.body)) return void res.status(400).json({ error: 'batch_not_supported' });
  const { token, principal } = who;
  const w = limits.tokenMinute.take(token.id) || limits.tokenDay.take(token.id) || limits.accountMinute.take(token.accountId);
  if (w) return tooMany(res, w);
  getMcpTokens().touch(token.id);

  const started = Date.now();
  const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
  const ctx = makeCtx(principal, token, internalBaseOf(req), originOf(req));
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
    logger.info({
      kind: 'mcp_call', tokenId: token.id, accountId: token.accountId,
      method: typeof body?.method === 'string' ? body.method.slice(0, 64) : null,
      tool: ctx.audit.tool ?? null, camera: ctx.audit.camera ?? null, outcome: ctx.audit.outcome ?? null,
      imageBytes: ctx.audit.imageBytes ?? 0, status: res.statusCode, durationMs: Date.now() - started,
    }, 'mcp_call');
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'mcp_request_failed');
    if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
  }
});

// A video link (spec §5): checked, then fetched through /api as its token.
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];
mcpRouter.get('/mcp/media/:link', mcpGate, async (req: Request, res: Response) => {
  res.set('Referrer-Policy', 'no-referrer');
  const p = verifyLink(String(req.params.link));
  if (p === 'expired') return void res.status(410).json({ error: 'link_expired' });
  const token = p === 'invalid' ? null : getMcpTokens().byId(p.tok);
  const path = p === 'invalid' ? null : mediaPath(p);
  if (p === 'invalid' || !token || token.accountId !== p.acc || !mcpPrincipal(token) || !path) return void res.status(403).json({ error: 'link_invalid' });
  const wait = limits.mediaMinute.take(token.id);
  if (wait) return tooMany(res, wait);
  const gone = new AbortController();
  res.on('close', () => gone.abort());
  const range = req.get('range');
  try {
    const up = await callApi(internalBaseOf(req), token.id, path, { headers: range && /^bytes=\d{0,15}-\d{0,15}$/.test(range) ? { range } : {}, signal: gone.signal });
    res.status(up.status);
    for (const h of PASS) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!up.body) return void res.end();
    await pipeline(Readable.fromWeb(up.body as unknown as WebReadableStream), res);
  } catch (err) {
    if (gone.signal.aborted) return;
    logger.warn({ message: (err as Error).message }, 'mcp_media_failed');
    if (!res.headersSent) res.status(502).json({ error: 'proxy_unavailable' });
    else res.destroy();
  }
});
