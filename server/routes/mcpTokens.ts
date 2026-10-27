// The Settings card's MCP tokens (spec 2026-10-27-mcp-server-design §6):
// every member issues and revokes their own; an account admin also lists and
// revokes everyone's in the account. Never a token's own internal call
// (requireAuthApi refuses those here). The token is in the issue answer only.
import { Router, type Request, type Response } from 'express';
import { logger } from '../logger';
import { loginToken, tokenFingerprint } from '../loginConfig';
import type { Principal } from '../middleware/requireAuth';
import { mcpEnabled, mcpPlainHttp } from '../mcp/config';
import { getMcpTokens, McpTokenError, TOKEN_ID, type McpIssuer } from '../mcp/tokens';

export const mcpTokensRouter = Router();

const principal = (res: Response): Principal => res.locals.principal as Principal;

function issuerOf(p: Principal): McpIssuer {
  if (p.via === 'token') {
    const t = loginToken();
    return { email: p.email, via: 'token', ...(t ? { tf: tokenFingerprint(t) } : {}) };
  }
  return { email: p.email, via: 'google' };
}

const endpointOf = (req: Request) => `${req.protocol}://${req.get('host')}/mcp`;

mcpTokensRouter.get('/api/mcp-tokens', (req: Request, res: Response) => {
  const p = principal(res);
  const all = req.query.all === '1';
  if (all && p.role !== 'admin') return void res.status(403).json({ error: 'forbidden_role' });
  const items = getMcpTokens().list(p.account.id, all ? {} : { issuer: p.email });
  res.json({ items, enabled: mcpEnabled(), plainHttp: mcpPlainHttp(), endpoint: endpointOf(req) });
});

mcpTokensRouter.post('/api/mcp-tokens', (req: Request, res: Response) => {
  const p = principal(res);
  try {
    const { token, item } = getMcpTokens().issue(p.account.id, issuerOf(p), req.body);
    logger.info({ kind: 'audit', tokenId: item.id, accountId: p.account.id, issuer: p.email, expiresAt: item.expiresAt }, 'mcp_token_issue');
    res.status(201).json({ token, item, endpoint: endpointOf(req) });
  } catch (err) {
    if (!(err instanceof McpTokenError)) throw err;
    res.status(err.status).json({ error: err.code, ...(err.field ? { field: err.field } : {}) });
  }
});

mcpTokensRouter.post('/api/mcp-tokens/:tokenId/revoke', (req: Request, res: Response) => {
  const p = principal(res);
  const id = String(req.params.tokenId);
  if (!TOKEN_ID.test(id)) return void res.status(404).json({ error: 'not_found' });
  const item = getMcpTokens().revoke(p.account.id, id, p.email, p.role === 'admin' ? undefined : p.email);
  if (!item) return void res.status(404).json({ error: 'not_found' });
  logger.info({ kind: 'audit', tokenId: item.id, accountId: p.account.id, issuer: item.issuer, revokedBy: p.email }, 'mcp_token_revoke');
  res.json({ item });
});
