import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getCamera } from '../cameraRegistry';
import { logger } from '../logger';
import { setProxyEnabled } from '../proxyState';
import { proxyHub, startProxyStream, stopProxyStream } from '../proxy/stream';
import { parseObjects, parseSummary } from '../proxy/analyses';
import { getProxyClient, ProxyClient, ProxyError, proxyCameraId } from '../proxy/client';

// Stills and preview sprites from a camera's cam-proxy, for the Timeline
// page (Plan 6). cams signs the browser in; the proxy's token is added here.
export const proxyRouter = Router();

const DAY = 86_400_000;
const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });

function proxied(req: Request, res: Response): { client: ProxyClient; cam: string; base: string } | undefined {
  const id = String(req.params.id);
  const camera = getCamera(id);
  if (!camera) return void res.status(404).json({ error: 'unknown_camera' }), undefined;
  const client = getProxyClient(id);
  if (!client) return void res.status(404).json({ error: 'no_proxy' }), undefined;
  return { client, cam: encodeURIComponent(camera.proxy?.camera ?? camera.id), base: `/api/cameras/${encodeURIComponent(camera.id)}` };
}

// The Settings page's "use cam-proxy" switch, for all users. Off: clips,
// thumbnails, stills and events come from the camera only.
proxyRouter.put('/api/cameras/:id/proxy', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const camera = getCamera(id);
  if (!camera) return void res.status(404).json({ error: 'unknown_camera' });
  if (!camera.proxy) return void res.status(404).json({ error: 'no_proxy' });
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
  if (typeof enabled !== 'boolean') return bad(res, 'enabled must be true or false');
  await setProxyEnabled(id, enabled);
  if (enabled) startProxyStream(id);
  else stopProxyStream(id);
  // Every open browser re-reads the camera list (which cameras use a proxy),
  // and it and the recordings cache reload this camera's events.
  proxyHub.emit('cameras');
  proxyHub.emit('message', { cam: id, type: 'reset', data: {} });
  logger.info({ cameraId: id, enabled }, 'proxy_switched');
  res.json({ enabled });
});

// Settings links to the camera's cam-proxy web UI while it answers (Klaus,
// 2026-09-28). cams only knows the proxy's internal URL; the proxy reports
// where people reach it (its publicUrl). Asked directly (even with the proxy
// switched off), with a short timeout.
async function proxyInfo(id: string, proxy: { url: string; token: string }): Promise<{ reachable: boolean; webUrl: string | null }> {
  let list: unknown;
  try {
    list = await new ProxyClient(proxy, { timeoutMs: 3000 }).json<unknown>('/api/cameras');
  } catch {
    return { reachable: false, webUrl: null };
  }
  // It answered: reachable. A link only for this camera's own entry.
  const mine = Array.isArray(list) ? (list as { id?: unknown; publicUrl?: unknown }[]).find((c) => c?.id === proxyCameraId(id)) : undefined;
  const url = mine?.publicUrl;
  return { reachable: true, webUrl: typeof url === 'string' && /^https?:\/\/[^\s]+$/.test(url) ? url : null };
}

proxyRouter.get('/api/cameras/:id/proxy/info', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const camera = getCamera(id);
  if (!camera) return void res.status(404).json({ error: 'unknown_camera' });
  if (!camera.proxy) return void res.status(404).json({ error: 'no_proxy' });
  res.json(await proxyInfo(id, camera.proxy));
});

// A signed-in cams user opens the proxy's UI without its token (Klaus,
// 2026-09-28): a one-time link, minted with the proxy's admin token. The
// token never leaves the server; the code works once, for 60 s.
proxyRouter.post('/api/cameras/:id/proxy/login-link', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const camera = getCamera(id);
  if (!camera) return void res.status(404).json({ error: 'unknown_camera' });
  if (!camera.proxy) return void res.status(404).json({ error: 'no_proxy' });
  if (!camera.proxy.adminToken) return void res.status(409).json({ error: 'no_login_link' });
  const info = await proxyInfo(id, camera.proxy);
  if (!info.reachable) return void res.status(502).json({ error: 'proxy_unavailable' });
  if (!info.webUrl) return void res.status(409).json({ error: 'no_login_link' });
  try {
    const r = await fetch(`${camera.proxy.url}/control/login-links`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${camera.proxy.adminToken}` },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    const body = (await r.json().catch(() => null)) as { code?: unknown } | null;
    if (!r.ok || typeof body?.code !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.code)) {
      logger.warn({ cameraId: id, status: r.status }, 'proxy_login_link_refused');
      return void res.status(502).json({ error: 'proxy_unavailable' });
    }
    // Under the public address's path; its query and hash dropped (issue #69).
    const u = new URL(info.webUrl);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/control/login-link`;
    u.search = `?code=${encodeURIComponent(body.code)}`;
    u.hash = '';
    res.json({ url: u.toString() });
  } catch (err) {
    logger.warn({ cameraId: id, message: (err as Error).message }, 'proxy_login_link_failed');
    res.status(502).json({ error: 'proxy_unavailable' });
  }
});

function range(req: Request, res: Response): [number, number] | undefined {
  const from = String(req.query.from ?? ''), to = String(req.query.to ?? '');
  if (!/^\d{1,15}$/.test(from) || !/^\d{1,15}$/.test(to) || Number(to) < Number(from)) return bad(res, 'from and to (unix ms) are required'), undefined;
  if (Number(to) - Number(from) > DAY) return bad(res, 'at most one day per request'), undefined;
  return [Number(from), Number(to)];
}

function proxyFailed(err: unknown, id: string, res: Response): void {
  // The browser left (a tile scrolled away, a page closed): nothing to answer.
  if (res.destroyed) return;
  if (!(err instanceof ProxyError)) throw err;
  // The proxy keeps no stills (stills.enabled false): say so, not "not reachable" (issue #38).
  if (err.status === 404 && err.upstream === 'stills_disabled' && !res.headersSent) return void res.status(404).json({ error: 'stills_disabled' });
  logger.warn({ cameraId: id, code: err.code, message: err.message }, 'proxy_request_failed');
  if (!res.headersSent) res.status(502).json({ error: 'proxy_unavailable' });
  else res.destroy();
}

proxyRouter.get('/api/cameras/:id/previews', async (req: Request, res: Response) => {
  const p = proxied(req, res);
  const r = p && range(req, res);
  if (!p || !r) return;
  try {
    const list = await p.client.json<{ minute: unknown; url: string }[]>(`/api/cameras/${p.cam}/previews`, { from: r[0], to: r[1] });
    // Only whole minutes: the value goes into URLs and CSS (issue #38).
    const ok = (Array.isArray(list) ? list : []).filter((m): m is { minute: number; url: string } => Number.isSafeInteger(m?.minute) && (m.minute as number) % 60_000 === 0);
    res.json(ok.map((m) => ({ ...m, url: `${p.base}/previews/${m.minute}.jpg` })));
  } catch (err) {
    proxyFailed(err, String(req.params.id), res);
  }
});

proxyRouter.get('/api/cameras/:id/stills', async (req: Request, res: Response) => {
  const p = proxied(req, res);
  const r = p && range(req, res);
  if (!p || !r) return;
  try {
    res.json(await p.client.json<number[]>(`/api/cameras/${p.cam}/stills`, { from: r[0], to: r[1] }));
  } catch (err) {
    proxyFailed(err, String(req.params.id), res);
  }
});

// One analysis in full, for the Timeline's "Show all objects": the summary
// and every object, never the provider's raw answer.
proxyRouter.get('/api/cameras/:id/analyses/:eventId', async (req: Request, res: Response) => {
  if (!/^\d{1,12}$/.test(String(req.params.eventId))) return bad(res, 'an event id is a number');
  const p = proxied(req, res);
  if (!p) return;
  const eventId = Number(req.params.eventId);
  try {
    const a = await p.client.json<{ status?: unknown; stillTs?: unknown; summary?: unknown; objects?: unknown }>(`/api/cameras/${p.cam}/events/${eventId}/analysis`);
    res.json({
      eventId,
      status: typeof a.status === 'string' ? a.status : 'unknown',
      stillTs: Number.isSafeInteger(a.stillTs) ? a.stillTs : null,
      summary: parseSummary(a.summary),
      objects: parseObjects(a.objects),
    });
  } catch (err) {
    if (err instanceof ProxyError && err.status === 404 && !res.headersSent) return void res.status(404).json({ error: 'not_found' });
    proxyFailed(err, String(req.params.id), res);
  }
});

// One image, streamed with the proxy's type and caching.
for (const kind of ['previews', 'stills'] as const) {
  proxyRouter.get(`/api/cameras/:id/${kind}/:file`, async (req: Request, res: Response) => {
    const m = /^(\d{1,15})\.jpg$/.exec(String(req.params.file));
    if (!m) return bad(res, 'an image is <unix ms>.jpg');
    const p = proxied(req, res);
    if (!p) return;
    // The proxy path is built from the parsed number, never the raw parameter.
    const ts = Number(m[1]);
    try {
      const up = await p.client.open(`/api/cameras/${p.cam}/${kind}/${ts}.jpg`, undefined, { idleMs: 10_000 });
      if (!up.ok || !up.body) {
        await up.body?.cancel();
        return void res.status(up.status === 404 ? 404 : 502).json({ error: up.status === 404 ? 'not_found' : 'proxy_unavailable' });
      }
      if (res.destroyed) return void (await up.body.cancel()); // the browser left while we waited
      res.status(200).set({ 'Content-Type': 'image/jpeg', 'Cache-Control': up.headers.get('cache-control') ?? 'no-store' });
      await pipeline(Readable.fromWeb(up.body as import('stream/web').ReadableStream), res);
    } catch (err) {
      proxyFailed(err, String(req.params.id), res);
    }
  });
}

// The Live page's fallback while its live stream isn't playing (Plan 7): the
// proxy's newest still of the last two minutes, never cached, with its time.
proxyRouter.get('/api/cameras/:id/still/latest.jpg', async (req: Request, res: Response) => {
  const p = proxied(req, res);
  if (!p) return;
  try {
    const now = Date.now();
    const stills = await p.client.json<number[]>(`/api/cameras/${p.cam}/stills`, { from: now - 120_000, to: now });
    const ts = stills.filter((t) => Number.isSafeInteger(t)).at(-1);
    if (ts === undefined) return void res.status(404).json({ error: 'not_found' });
    const up = await p.client.open(`/api/cameras/${p.cam}/stills/${ts}.jpg`, undefined, { idleMs: 10_000 });
    if (!up.ok || !up.body) {
      await up.body?.cancel();
      return void res.status(up.status === 404 ? 404 : 502).json({ error: up.status === 404 ? 'not_found' : 'proxy_unavailable' });
    }
    if (res.destroyed) return void (await up.body?.cancel()); // the browser left while we waited
    res.status(200).set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Still-Time': String(ts) });
    await pipeline(Readable.fromWeb(up.body as import('stream/web').ReadableStream), res);
  } catch (err) {
    proxyFailed(err, String(req.params.id), res);
  }
});
