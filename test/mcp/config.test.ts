import { describe, expect, it } from 'vitest';
import { mcpMode } from '../../server/mcp/config';
import { assertRequiredEnv } from '../../server/config';
import { logger } from '../../server/logger';

describe('mcpMode', () => {
  it('is on by default; MCP_ENABLED=false turns it off', () => {
    expect(mcpMode({})).toBe('on');
    expect(mcpMode({ MCP_ENABLED: 'true' })).toBe('on');
    expect(mcpMode({ MCP_ENABLED: 'false' })).toBe('off');
  });

  it('needs MCP_ALLOW_HTTP=true on a plain http viewer', () => {
    // Off without a word by default; refused (and logged) when asked for explicitly.
    expect(mcpMode({ COOKIE_SECURE: 'false' })).toBe('off');
    expect(mcpMode({ MCP_ENABLED: 'true', COOKIE_SECURE: 'false' })).toBe('http-refused');
    expect(mcpMode({ COOKIE_SECURE: 'false', MCP_ALLOW_HTTP: 'true' })).toBe('on');
    expect(mcpMode({ MCP_ENABLED: 'false', COOKIE_SECURE: 'false', MCP_ALLOW_HTTP: 'true' })).toBe('off');
  });
});

describe('startup', () => {
  it('logs mcp_http_refused once when a plain http viewer lacks the opt-in', () => {
    const seen: string[] = [];
    const orig = logger.warn.bind(logger);
    (logger as unknown as { warn: unknown }).warn = (_o: unknown, msg?: string) => void seen.push(String(msg));
    process.env.MCP_ENABLED = 'true';
    process.env.COOKIE_SECURE = 'false';
    try {
      assertRequiredEnv();
      expect(seen).toContain('mcp_http_refused');
    } finally {
      (logger as unknown as { warn: unknown }).warn = orig;
      delete process.env.MCP_ENABLED;
      delete process.env.COOKIE_SECURE;
    }
  });
});
