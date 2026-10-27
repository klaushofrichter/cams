// /mcp (spec 2026-10-27-mcp-server-design §6–§8): off unless enabled, POST
// only, the server's own Origin or none, a live bearer token, the limits, then
// a stateless Streamable HTTP transport with JSON answers. One audit line per
// request; never the token.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../logger';
import { bearerPrincipal } from './auth';
import { mcpEnabled } from './config';
import { internalBaseOf } from './internal';
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
