// /mcp itself (spec §6–§8): the switch, the bearer token, the transport rules,
// the limits and the audit line; list_cameras through the SDK's own client.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { setCameras } from '../../server/cameraRegistry';
import { logger } from '../../server/logger';
import { getMcpTokens } from '../../server/mcp/tokens';
import { resetMcpLimits } from '../../server/mcp/limits';
import { createSimCamera } from '../camera/sim';
import { freshTokens, issue, mcpClient, startApp, type Running } from './helpers';

let app: Running, cam: Server;
beforeAll(async () => {
  const sim = await createSimCamera({ user: 'u', password: 'p' });
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await new Promise((r) => cam.close(r));
});
beforeEach(() => {
  freshTokens();
  resetMcpLimits();
  process.env.MCP_ENABLED = 'true';
  setCameras([{ id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' }]);
});
afterEach(() => {
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_ALLOW_HTTP;
  delete process.env.COOKIE_SECURE;
  delete process.env.RATE_LIMIT_MCP_PER_MIN;
  setCameras([]);
});

const rpc = (token?: string, extra: Record<string, string> = {}) =>
  fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

describe('/mcp', () => {
  it('answers 401 with WWW-Authenticate without a live token', async () => {
    const r = await rpc();
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(await r.json()).toEqual({ error: 'unauthorized' });
    const { token, id } = issue();
    getMcpTokens().revoke(getMcpTokens().byId(id)!.accountId, id, 'x');
    expect((await rpc(token)).status).toBe(401);
    expect((await rpc('cmcp_' + 'x'.repeat(43))).status).toBe(401);
  });

  it('is 404 when off, and on plain http without the opt-in', async () => {
    const { token } = issue();
    process.env.MCP_ENABLED = 'false';
    expect((await rpc(token)).status).toBe(404);
    process.env.MCP_ENABLED = 'true';
    process.env.COOKIE_SECURE = 'false';
    expect((await rpc(token)).status).toBe(404);
    process.env.MCP_ALLOW_HTTP = 'true';
    expect((await rpc(token)).status).toBe(200);
  });

  it('refuses GET and a foreign Origin', async () => {
    const { token } = issue();
    expect((await fetch(`${app.url}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await rpc(token, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await rpc(token, { origin: app.url })).status).toBe(200);
  });

  it('lists the tools and runs list_cameras through the SDK client', async () => {
    const { token } = issue();
    const client = await mcpClient(app.url, token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('list_cameras');
    const r = await client.callTool({ name: 'list_cameras', arguments: {} });
    expect(r.isError).toBeFalsy();
    const cams = (r.structuredContent as { cameras: { id: string; name: string; online: boolean | null; hasProxy: boolean; simulated: boolean }[] }).cameras;
    expect(cams).toEqual([expect.objectContaining({ id: 'cam1', name: 'Den', online: true, hasProxy: false, simulated: true })]);
    await client.close();
  });

  it('limits calls per token and logs each call without the token', async () => {
    process.env.RATE_LIMIT_MCP_PER_MIN = '3';
    const lines: Record<string, unknown>[] = [];
    const orig = logger.info.bind(logger);
    (logger as unknown as { info: unknown }).info = (o: Record<string, unknown>, msg?: string) => void (typeof msg === 'string' && msg.startsWith('mcp') && lines.push({ ...o, msg }));
    try {
      const { token, id } = issue();
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await rpc(token)).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      const call = lines.find((l) => l.msg === 'mcp_call');
      expect(call).toMatchObject({ kind: 'mcp_call', tokenId: id, method: 'tools/list' });
      expect(JSON.stringify(lines)).not.toContain(token);
    } finally {
      (logger as unknown as { info: unknown }).info = orig;
    }
  });
});

describe('/mcp batches', () => {
  it('refuses a JSON-RPC batch (it would slip past the per-call limits)', async () => {
    const { token } = issue();
    const r = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'batch_not_supported' });
  });
});
