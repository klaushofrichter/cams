// The Settings card's MCP tokens (spec 2026-10-27-mcp-server-design §6).
export interface McpToken {
  id: string;
  name: string;
  issuer: string;
  accountId: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
  callsToday: number;
  state: 'active' | 'expired' | 'revoked';
}
export interface McpTokenList { items: McpToken[]; enabled: boolean; plainHttp: boolean; endpoint: string }

export const DAY_CHOICES = [7, 30, 90] as const;

export const claudeAddLine = (endpoint: string, token: string): string =>
  `claude mcp add --transport http cams ${endpoint} --header "Authorization: Bearer ${token}"`;

export function issueError(status: number, code: string | null, field?: string | null): string {
  if (status === 409 || code === 'too_many_tokens') return 'You have the most tokens allowed (3 per person, 20 per account). Revoke one first.';
  if (code === 'invalid' && field === 'name') return 'Give the token a name of 1 to 64 characters.';
  if (code === 'invalid') return 'That is not a valid choice.';
  return 'The token could not be created. Try again.';
}

export function tokenState(t: Pick<McpToken, 'state' | 'expiresAt'>, now = Date.now()): string {
  if (t.state === 'revoked') return 'Revoked';
  if (t.state === 'expired') return 'Expired';
  const days = Math.floor((t.expiresAt - now) / 86_400_000);
  return days < 1 ? 'Expires today' : days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`;
}

export const when = (ms: number | null): string => (ms === null ? 'never' : new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
