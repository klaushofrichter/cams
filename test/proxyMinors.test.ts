// Issue #38: deferred minors from the cam-proxy integration reviews.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { inspect } from 'util';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { ProxyClient, resetProxyClients } from '../server/proxy/client';
import { closeEventStreams, eventStreamCount } from '../server/routes/events';
import { logger } from '../server/logger';
import { SESSION_COOKIE, signSession } from '../server/session';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const TOKEN = 'minors-proxy-client-token-'.padEnd(48, 'q');
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  setCameras([]);
  resetProxyClients();
  vi.restoreAllMocks();
});

// A stand-in proxy: records the paths asked, answers with `handle`.
async function standIn(handle: (req: express.Request, res: express.Response) => void) {
  const paths: string[] = [];
  const app = express();
  app.use((req, res) => {
    paths.push(req.path);
    handle(req, res);
  });
  server = app.listen(0);
  await new Promise((r) => server!.once('listening', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, paths };
}
function useProxy(url: string) {
  setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url, token: TOKEN } }]);
  resetProxyClients();
}

describe('cam-proxy minors (#38)', () => {
  it('keeps a proxy URL path prefix', async () => {
    const p = await standIn((_req, res) => void res.json([]));
    await new ProxyClient({ url: `${p.url}/gateway`, token: TOKEN }).json('/api/cameras');
    expect(p.paths).toEqual(['/gateway/api/cameras']);
  });

  it('drops preview entries whose minute is not a whole minute', async () => {
    const good = 1_790_000_040_000 - (1_790_000_040_000 % 60_000);
    const p = await standIn((_req, res) => void res.json([{ minute: good, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: [] }, { minute: '1;x' }, { minute: good + 1234 }]));
    useProxy(p.url);
    const r = await request(createApp()).get(`/api/cameras/den/previews?from=${good}&to=${good + 60_000}`).set('Cookie', auth);
    expect(r.body.map((m: { minute: number }) => m.minute)).toEqual([good]);
  });

  it('says stills are off at the proxy, instead of "not reachable"', async () => {
    const p = await standIn((_req, res) => void res.status(404).json({ error: 'stills_disabled' }));
    useProxy(p.url);
    const r = await request(createApp()).get('/api/cameras/den/stills?from=0&to=1000').set('Cookie', auth);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'stills_disabled' });
  });

  it('never writes the proxy token into a log line', async () => {
    const lines: string[] = [];
    // inspect, not JSON.stringify: pino-http logs req/res, which are circular.
    for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => void lines.push(inspect(a, { depth: 6 }))) as never);
    const p = await standIn((_req, res) => void res.status(500).json({ error: 'boom' }));
    useProxy(p.url);
    await request(createApp()).get('/api/cameras/den/stills?from=0&to=1000').set('Cookie', auth);
    useProxy('http://127.0.0.1:9'); // unreachable
    await request(createApp()).get('/api/cameras/den/stills?from=0&to=1000').set('Cookie', auth);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('caps the event relay at 20 browsers, and ends every relay on shutdown', async () => {
    const app = createApp();
    const http = app.listen(0);
    await new Promise((r) => http.once('listening', r));
    const port = (http.address() as AddressInfo).port;
    const open: import('http').ClientRequest[] = [];
    const statuses = await Promise.all(Array.from({ length: 21 }, () => new Promise<number>((resolve) => {
      const req = require('http').get({ port, path: '/api/events/stream', headers: { Cookie: auth } }, (res: import('http').IncomingMessage) => resolve(res.statusCode ?? 0));
      open.push(req);
    })));
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.filter((s) => s === 503)).toHaveLength(1);
    expect(eventStreamCount()).toBe(20);
    closeEventStreams();
    await new Promise((r) => setTimeout(r, 50));
    expect(eventStreamCount()).toBe(0);
    for (const r of open) r.destroy();
    await new Promise<void>((r) => http.close(() => r()));
  });
});
