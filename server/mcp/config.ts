// Whether this cams serves /mcp (spec 2026-10-27-mcp-server-design §6,
// "Instances"): on unless MCP_ENABLED=false (Klaus, 2026-10-27: on by
// default). A plain http viewer (COOKIE_SECURE false: the Pi, the mini PC)
// also needs MCP_ALLOW_HTTP=true, Klaus's LAN opt-in; without it it is off,
// and refused with a warning only when MCP_ENABLED=true asks for it.
import { cookieSecure } from '../loginConfig';

export type McpMode = 'off' | 'on' | 'http-refused';

export function mcpMode(env: NodeJS.ProcessEnv = process.env): McpMode {
  if (env.MCP_ENABLED === 'false') return 'off';
  if (!cookieSecure(env) && env.MCP_ALLOW_HTTP !== 'true') return env.MCP_ENABLED === 'true' ? 'http-refused' : 'off';
  return 'on';
}

export const mcpEnabled = (): boolean => mcpMode() === 'on';
// Tokens and links travel unencrypted on this viewer (the Settings card says so).
export const mcpPlainHttp = (): boolean => !cookieSecure();
