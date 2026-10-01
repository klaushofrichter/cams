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

// The jobs cams started, per camera, with cams's own copy of the proxy's id:
// only those are asked about, and never by the id from the request (CodeQL
// js/request-forgery). Kept a little longer than the proxy keeps a result.
const started = new Map<string, { id: string; at: number }>();
const KEEP_MS = 20 * 60_000;
const keyOf = (cam: string, job: string) => `${cam}\u0000${job}`;
function remember(cam: string, id: string) {
  const t = Date.now();
  for (const [k, v] of started) if (t - v.at > KEEP_MS) started.delete(k);
  started.set(keyOf(cam, id), { id, at: t });
}
function known(cam: string, req: Request, res: Response): string | undefined {
  const job = started.get(keyOf(cam, String(req.params.job)))?.id;
  if (!job) res.status(404).json({ error: 'not_found' });
  return job;
}

composeRouter.post('/api/cameras/:id/compositions', async (req, res) => {
  const t = target(req, res);
  if (!t) return;
  const b = (req.body ?? {}) as { eventId?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown; timeZone?: unknown };
  if (typeof b.eventId !== 'string' || !EVENT.test(b.eventId)) return void res.status(400).json({ error: 'invalid', detail: 'eventId is required' });
  try {
    let clip: { id: number } | null;
    try {
      clip = await getRecordings().proxyClipOf(t.id, b.eventId);
    } catch (err) {
      return void lookupFailed(t.id, err, res);
    }
    if (!clip) return void res.status(404).json({ error: 'no_clip' });
    const up = await t.client.open(t.base, undefined, { method: 'POST', body: JSON.stringify({ clipId: clip.id, preS: b.preS, postS: b.postS, size: b.size, badge: b.badge, ...(typeof b.timeZone === 'string' ? { timeZone: b.timeZone } : {}) }) });
    const text = await up.text();
    if (up.status === 201) {
      const id = (JSON.parse(text) as { id?: unknown }).id;
      if (typeof id === 'string' && JOB.test(id)) remember(t.id, id);
    }
    res.status(up.status);
    if (text) res.type('application/json').send(text);
    else res.end();
  } catch (err) {
    failed(err, res);
  }
});

// The event → proxy clip lookup failed (the proxy, or the camera's day list):
// not "no copy", which the dialog would take as final (issue #76).
function lookupFailed(id: string, err: unknown, res: Response) {
  logger.warn({ cameraId: id, message: (err as Error).message }, 'proxy_clip_lookup_failed');
  res.status(502).json({ error: 'proxy_unavailable' });
}

// Whether the proxy has a copy of the event at all (issue #72): the dialog
// offers pre-/post-roll only then. A camera without a proxy: false. A failed
// lookup: 502, and the dialog stays on the full choice.
composeRouter.get('/api/cameras/:id/compositions/available', async (req, res) => {
  const id = String(req.params.id);
  if (!getCamera(id)) return void res.status(404).json({ error: 'unknown_camera' });
  const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : '';
  if (!EVENT.test(eventId)) return void res.status(400).json({ error: 'invalid', detail: 'eventId is required' });
  if (!getProxyClient(id)) return void res.json({ available: false });
  try {
    res.json({ available: !!(await getRecordings().proxyClipOf(id, eventId)) });
  } catch (err) {
    lookupFailed(id, err, res);
  }
});

composeRouter.get('/api/cameras/:id/compositions/:job', async (req, res) => {
  if (!jobOk(req, res)) return;
  const t = target(req, res);
  if (!t) return;
  const job = known(t.id, req, res);
  if (!job) return;
  try {
    await relay(res, await t.client.open(`${t.base}/${job}`));
  } catch (err) {
    failed(err, res);
  }
});

composeRouter.get('/api/cameras/:id/compositions/:job/video', async (req, res) => {
  if (!jobOk(req, res)) return;
  const t = target(req, res);
  if (!t) return;
  const job = known(t.id, req, res);
  if (!job) return;
  try {
    // Byte ranges pass through: iOS Safari plays a <video> only with them (issue #72).
    const range = req.get('range');
    const up = await t.client.open(`${t.base}/${job}.mp4`, undefined, { idleMs: 30_000, headers: range && /^bytes=\d*-\d*$/.test(range) ? { Range: range } : {} });
    if (!up.ok || !up.body) return void (await relay(res, up));
    const name = typeof req.query.name === 'string' && NAME.test(req.query.name) ? req.query.name : 'composed.mp4';
    res.status(up.status === 206 ? 206 : 200).set({
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Disposition': req.query.inline === '1' ? 'inline' : `attachment; filename="${name}"`,
    });
    const len = up.headers.get('content-length');
    if (len && /^\d+$/.test(len)) res.setHeader('Content-Length', len);
    const cr = up.headers.get('content-range');
    if (cr && /^bytes \d+-\d+\/\d+$/.test(cr)) res.setHeader('Content-Range', cr);
    await pipeline(Readable.fromWeb(up.body as import('stream/web').ReadableStream), res);
  } catch (err) {
    failed(err, res);
  }
});

composeRouter.delete('/api/cameras/:id/compositions/:job', async (req, res) => {
  if (!jobOk(req, res)) return;
  const t = target(req, res);
  if (!t) return;
  const job = known(t.id, req, res);
  if (!job) return;
  started.delete(keyOf(t.id, job));
  try {
    await relay(res, await t.client.open(`${t.base}/${job}`, undefined, { method: 'DELETE' }));
  } catch (err) {
    failed(err, res);
  }
});
