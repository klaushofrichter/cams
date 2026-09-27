import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getCamera } from '../cameraRegistry';
import { logger } from '../logger';
import { getProxyClient, proxyCameraId, ProxyError, type ProxyClient } from '../proxy/client';

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
  return { client, cam: encodeURIComponent(proxyCameraId(id)), base: `/api/cameras/${encodeURIComponent(id)}` };
}

function range(req: Request, res: Response): [number, number] | undefined {
  const from = String(req.query.from ?? ''), to = String(req.query.to ?? '');
  if (!/^\d{1,15}$/.test(from) || !/^\d{1,15}$/.test(to) || Number(to) < Number(from)) return bad(res, 'from and to (unix ms) are required'), undefined;
  if (Number(to) - Number(from) > DAY) return bad(res, 'at most one day per request'), undefined;
  return [Number(from), Number(to)];
}

function proxyFailed(err: unknown, id: string, res: Response): void {
  if (!(err instanceof ProxyError)) throw err;
  logger.warn({ cameraId: id, code: err.code, message: err.message }, 'proxy_request_failed');
  if (!res.headersSent) res.status(502).json({ error: 'proxy_unavailable' });
  else res.destroy();
}

proxyRouter.get('/api/cameras/:id/previews', async (req: Request, res: Response) => {
  const p = proxied(req, res);
  const r = p && range(req, res);
  if (!p || !r) return;
  try {
    const list = await p.client.json<{ minute: number; url: string }[]>(`/api/cameras/${p.cam}/previews`, { from: r[0], to: r[1] });
    res.json(list.map((m) => ({ ...m, url: `${p.base}/previews/${m.minute}.jpg` })));
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

// One image, streamed with the proxy's type and caching.
for (const kind of ['previews', 'stills'] as const) {
  proxyRouter.get(`/api/cameras/:id/${kind}/:file`, async (req: Request, res: Response) => {
    if (!/^\d{1,15}\.jpg$/.test(String(req.params.file))) return bad(res, 'an image is <unix ms>.jpg');
    const p = proxied(req, res);
    if (!p) return;
    try {
      const up = await p.client.open(`/api/cameras/${p.cam}/${kind}/${req.params.file}`, undefined, { idleMs: 10_000 });
      if (!up.ok || !up.body) {
        await up.body?.cancel();
        return void res.status(up.status === 404 ? 404 : 502).json({ error: up.status === 404 ? 'not_found' : 'proxy_unavailable' });
      }
      res.status(200).set({ 'Content-Type': 'image/jpeg', 'Cache-Control': up.headers.get('cache-control') ?? 'no-store' });
      await pipeline(Readable.fromWeb(up.body as import('stream/web').ReadableStream), res);
    } catch (err) {
      proxyFailed(err, String(req.params.id), res);
    }
  });
}
