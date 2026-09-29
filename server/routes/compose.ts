import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getCamera } from '../cameraRegistry';
import { logger } from '../logger';
import { getProxyClient, proxyCameraId, ProxyError } from '../proxy/client';
import { getRecordings } from '../recordings/service';

// Composed clips (cam-proxy spec 2026-09-28): the Downloads modal's calls,
// passed to the camera's cam-proxy with its token.
export const composeRouter = Router();
const JOB = /^[A-Za-z0-9_-]{22}$/;
const EVENT = /^\d{8}-\d{6}-\d{6}$/;
const NAME = /^[A-Za-z0-9_.-]{1,120}\.mp4$/;

function target(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!getCamera(id)) return void res.status(404).json({ error: 'unknown_camera' }), undefined;
  const client = getProxyClient(id);
  if (!client) return void res.status(404).json({ error: 'no_proxy' }), undefined;
  return { id, client, base: `/api/cameras/${encodeURIComponent(proxyCameraId(id))}/compositions` };
}
function failed(err: unknown, res: Response) {
  if (!(err instanceof ProxyError)) throw err;
  logger.warn({ code: err.code, message: err.message }, 'compose_proxy_failed');
  if (!res.headersSent) res.status(502).json({ error: 'proxy_unavailable' });
  else res.destroy();
}
// The proxy's status and JSON body, as they are.
async function relay(res: Response, up: globalThis.Response) {
  res.status(up.status);
  const text = await up.text();
  if (text) res.type('application/json').send(text);
  else res.end();
}
const jobOk = (req: Request, res: Response) => (JOB.test(String(req.params.job)) ? true : (res.status(400).json({ error: 'invalid' }), false));

composeRouter.post('/api/cameras/:id/compositions', async (req, res) => {
  const t = target(req, res);
  if (!t) return;
  const b = (req.body ?? {}) as { eventId?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown };
  if (typeof b.eventId !== 'string' || !EVENT.test(b.eventId)) return void res.status(400).json({ error: 'invalid', detail: 'eventId is required' });
  try {
    const clip = await getRecordings().proxyClipOf(t.id, b.eventId);
    if (!clip) return void res.status(404).json({ error: 'no_clip' });
    const up = await t.client.open(t.base, undefined, { method: 'POST', body: JSON.stringify({ clipId: clip.id, preS: b.preS, postS: b.postS, size: b.size, badge: b.badge }) });
    await relay(res, up);
  } catch (err) {
    failed(err, res);
  }
});

composeRouter.get('/api/cameras/:id/compositions/:job', async (req, res) => {
  if (!jobOk(req, res)) return;
  const t = target(req, res);
  if (!t) return;
  try {
    await relay(res, await t.client.open(`${t.base}/${req.params.job}`));
  } catch (err) {
    failed(err, res);
  }
});

composeRouter.get('/api/cameras/:id/compositions/:job/video', async (req, res) => {
  if (!jobOk(req, res)) return;
  const t = target(req, res);
  if (!t) return;
  try {
    const up = await t.client.open(`${t.base}/${req.params.job}.mp4`, undefined, { idleMs: 30_000 });
    if (!up.ok || !up.body) return void (await relay(res, up));
    const name = typeof req.query.name === 'string' && NAME.test(req.query.name) ? req.query.name : 'composed.mp4';
    res.status(200).set({
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Content-Disposition': req.query.inline === '1' ? 'inline' : `attachment; filename="${name}"`,
    });
    const len = up.headers.get('content-length');
    if (len && /^\d+$/.test(len)) res.setHeader('Content-Length', len);
    await pipeline(Readable.fromWeb(up.body as import('stream/web').ReadableStream), res);
  } catch (err) {
    failed(err, res);
  }
});

composeRouter.delete('/api/cameras/:id/compositions/:job', async (req, res) => {
  if (!jobOk(req, res)) return;
  const t = target(req, res);
  if (!t) return;
  try {
    await relay(res, await t.client.open(`${t.base}/${req.params.job}`, undefined, { method: 'DELETE' }));
  } catch (err) {
    failed(err, res);
  }
});
