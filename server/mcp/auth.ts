// An MCP token as a principal (spec 2026-10-27-mcp-server-design §6): its
// issuer, in its account, with the issuer's role right now. A removed or
// disabled issuer, an account no longer served, a changed token login: null.
import { principalIn, type Principal } from '../middleware/requireAuth';
import { getMcpTokens, type StoredToken } from './tokens';

export function mcpPrincipal(t: StoredToken): Principal | null {
  const p = principalIn(t.issuer, t.accountId);
  return p && { ...p, via: 'mcp', mcpTokenId: t.id };
}

// `Authorization: Bearer cmcp_…`; null for anything else.
export function bearerPrincipal(header: string | undefined): { token: StoredToken; principal: Principal } | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header.trim());
  if (!m) return null;
  const token = getMcpTokens().find(m[1]);
  const principal = token && mcpPrincipal(token);
  return token && principal ? { token, principal } : null;
}
