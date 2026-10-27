// Whether this cams serves /mcp (spec 2026-10-27-mcp-server-design §6,
// "Instances"): MCP_ENABLED=true, and on a plain http viewer (COOKIE_SECURE
// false: the Pi, the mini PC) also MCP_ALLOW_HTTP=true, Klaus's LAN opt-in.
import { cookieSecure } from '../loginConfig';

export type McpMode = 'off' | 'on' | 'http-refused';

export function mcpMode(env: NodeJS.ProcessEnv = process.env): McpMode {
  if (env.MCP_ENABLED !== 'true') return 'off';
  if (!cookieSecure(env) && env.MCP_ALLOW_HTTP !== 'true') return 'http-refused';
  return 'on';
}

export const mcpEnabled = (): boolean => mcpMode() === 'on';
// Tokens and links travel unencrypted on this viewer (the Settings card says so).
export const mcpPlainHttp = (): boolean => !cookieSecure();
