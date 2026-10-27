import { describe, expect, it } from 'vitest';
import { claudeAddLine, issueError, tokenState } from './mcpTokens';

describe('mcpTokens', () => {
  it('builds the claude mcp add line', () => {
    expect(claudeAddLine('https://cams.example/mcp', 'cmcp_abc')).toBe('claude mcp add --transport http cams https://cams.example/mcp --header "Authorization: Bearer cmcp_abc"');
  });

  it('words the refusals', () => {
    expect(issueError(409, 'too_many_tokens')).toMatch(/revoke one/i);
    expect(issueError(400, 'invalid', 'name')).toMatch(/name/i);
    expect(issueError(500, null)).toMatch(/could not/i);
  });

  it('words a token’s state', () => {
    const now = Date.UTC(2026, 9, 27);
    expect(tokenState({ state: 'active', expiresAt: now + 3 * 86_400_000 }, now)).toBe('Expires in 3 days');
    expect(tokenState({ state: 'active', expiresAt: now + 3_600_000 }, now)).toBe('Expires today');
    expect(tokenState({ state: 'revoked', expiresAt: now }, now)).toBe('Revoked');
    expect(tokenState({ state: 'expired', expiresAt: now }, now)).toBe('Expired');
  });
});
