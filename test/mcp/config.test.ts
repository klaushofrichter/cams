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
