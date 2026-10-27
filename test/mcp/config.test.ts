import { describe, expect, it } from 'vitest';
import { mcpMode } from '../../server/mcp/config';

describe('mcpMode', () => {
  it('is off unless MCP_ENABLED=true', () => {
    expect(mcpMode({})).toBe('off');
    expect(mcpMode({ MCP_ENABLED: 'yes' })).toBe('off');
    expect(mcpMode({ MCP_ENABLED: 'true' })).toBe('on');
  });

  it('needs MCP_ALLOW_HTTP=true on a plain http viewer', () => {
    expect(mcpMode({ MCP_ENABLED: 'true', COOKIE_SECURE: 'false' })).toBe('http-refused');
    expect(mcpMode({ MCP_ENABLED: 'true', COOKIE_SECURE: 'false', MCP_ALLOW_HTTP: 'true' })).toBe('on');
    expect(mcpMode({ MCP_ALLOW_HTTP: 'true', COOKIE_SECURE: 'false' })).toBe('off');
  });
});

describe('startup', () => {
  it('logs mcp_http_refused once when a plain http viewer lacks the opt-in', async () => {
    const { assertRequiredEnv } = await import('../../server/config');
    const { logger } = await import('../../server/logger');
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
