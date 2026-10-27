// Video links (spec §5): signed, 15 minutes, dead with their token.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCameras } from '../../server/cameraRegistry';
import { fileAccount } from '../../server/fleet';
import { signLink, verifyLink } from '../../server/mcp/links';
import { resetMcpLimits } from '../../server/mcp/limits';
import { getMcpTokens } from '../../server/mcp/tokens';
import { resetProxyClients } from '../../server/proxy/client';
import { stopProxyStreams } from '../../server/proxy/stream';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from '../proxy/fakeProxy';
import { freshTokens, issue, startApp, type Running } from './helpers';

let app: Running, proxy: FakeProxy, itemId: number;
const BODY = Buffer.from('0123456789'.repeat(100));
beforeAll(async () => {
  proxy = await startFakeProxy();
  itemId = proxy.archive.add('cam1', { name: 'kept', body: BODY }).id;
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await proxy.stop();
});
beforeEach(() => {
  freshTokens();
  resetMcpLimits();
  resetProxyClients();
  process.env.MCP_ENABLED = 'true';
  setCameras([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: proxy.url, token: FAKE_TOKEN } }]);
});
afterEach(() => {
  stopProxyStreams();
  delete process.env.MCP_ENABLED;
  delete process.env.RATE_LIMIT_MCP_MEDIA_PER_MIN;
  setCameras([]);
});

const link = (tok: string, o: Partial<{ acc: string; cam: string; ref: string; exp: number }> = {}) =>
  `${app.url}/mcp/media/${signLink({ tok, acc: o.acc ?? fileAccount().id, cam: o.cam ?? 'cam1', kind: 'archive', ref: o.ref ?? String(itemId), exp: o.exp ?? Date.now() + 60_000 })}`;

describe('signLink / verifyLink', () => {
  it('round-trips and refuses a changed byte or a past expiry', () => {
    const s = signLink({ tok: 'mtk_X', acc: 'acc_A', cam: 'cam1', kind: 'clip', ref: '20260101-000000-000010', exp: Date.now() + 1000 });
    expect(verifyLink(s)).toMatchObject({ v: 1, tok: 'mtk_X', kind: 'clip' });
    const [data, sig] = s.split('.');
    const flipped = `${data.slice(0, -2)}${data.at(-2) === 'A' ? 'B' : 'A'}${data.at(-1)}.${sig}`;
    expect(verifyLink(flipped)).toBe('invalid');
    expect(verifyLink(`${data}.${'A'.repeat(43)}`)).toBe('invalid');
    expect(verifyLink(s, Date.now() + 2000)).toBe('expired');
  });
});

describe('GET /mcp/media/:link', () => {
  it('streams the video as the token, with Range passed through', async () => {
    const { id } = issue();
    const r = await fetch(link(id));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(Buffer.from(await r.arrayBuffer()).equals(BODY)).toBe(true);
    const part = await fetch(link(id), { headers: { Range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('0123456789');
  });

  it('is 410 once expired and 403 when tampered, revoked or for another account', async () => {
    const { id } = issue();
    expect((await fetch(link(id, { exp: Date.now() - 1 }))).status).toBe(410);
    expect((await fetch(`${link(id).slice(0, -3)}AAA`)).status).toBe(403);
    expect((await fetch(link(id, { acc: 'acc_OTHEROTHEROTHER' }))).status).toBe(403);
    getMcpTokens().revoke(fileAccount().id, id, 'x');
    const r = await fetch(link(id));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'link_invalid' });
  });

  it('is 404 for a camera the account lacks, and limited per token', async () => {
    const { id } = issue();
    expect((await fetch(link(id, { cam: 'nope' }))).status).toBe(404);
    process.env.RATE_LIMIT_MCP_MEDIA_PER_MIN = '1';
    resetMcpLimits();
    expect((await fetch(link(id))).status).toBe(200);
    expect((await fetch(link(id))).status).toBe(429);
  });

  it('is 404 while MCP is off', async () => {
    const { id } = issue();
    process.env.MCP_ENABLED = 'false';
    expect((await fetch(link(id))).status).toBe(404);
  });
});

describe('the request log', () => {
  it('never carries a signed link', async () => {
    const { createHttpLogger } = await import('../../server/logger.js');
    const { Writable } = await import('stream');
    const express = (await import('express')).default;
    const lines: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
    const a = express();
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    try {
      a.use(createHttpLogger(sink));
    } finally {
      process.env.LOG_LEVEL = prev;
    }
    a.get('/mcp/media/:link', (_req, res) => void res.status(200).end());
    const http = await import('http');
    const s = http.createServer(a);
    await new Promise<void>((r) => s.listen(0, () => r()));
    const port = (s.address() as { port: number }).port;
    const secret = signLink({ tok: 'mtk_X', acc: 'acc_A', cam: 'cam1', kind: 'clip', ref: '20260101-000000-000010', exp: Date.now() + 60_000 });
    await fetch(`http://127.0.0.1:${port}/mcp/media/${secret}`);
    await new Promise<void>((r) => s.close(() => r()));
    const text = lines.join('');
    expect(text).toContain('/mcp/media/:link');
    expect(text).not.toContain(secret.split('.')[1]);
  });
});
