// Shared by the MCP tests: a fresh token file per test, a listening app, and
// the SDK's own client against it.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../../server/app';
import { getMcpTokens, resetMcpTokens, type McpIssuer } from '../../server/mcp/tokens';
import { fileAccount } from '../../server/fleet';

export const KLAUS = 'klaus@klaushofrichter.net';

export function freshTokens(): void {
  process.env.MCP_TOKENS_FILE = join(mkdtempSync(join(tmpdir(), 'cams-mcp-tok-')), 'mcp', 'tokens.json');
  resetMcpTokens();
}

export function issue(accountId: string = fileAccount().id, issuer: McpIssuer | string = KLAUS, name = 'test'): { token: string; id: string } {
  const who = typeof issuer === 'string' ? { email: issuer, via: 'google' as const } : issuer;
  const { token, item } = getMcpTokens().issue(accountId, who, { name });
  return { token, id: item.id };
}

export interface Running { url: string; port: number; close: () => Promise<void> }
export async function startApp(): Promise<Running> {
  const server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

export async function mcpClient(url: string, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'cams-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
