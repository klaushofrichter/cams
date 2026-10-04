import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { aroundLength, generateMaxS, resultLength } from '../clipLimits';
import { logger } from '../logger';
import { getProxyClient, proxyPath, ProxyError, type ProxyClient } from '../proxy/client';
import { CLIP_ID as EVENT, offsetAt, offsetStamp, zoneStamp, type TimeInfo } from '../recordings/clipNames';
import { getRecordings } from '../recordings/service';
import { getClient } from '../reolink/clients';
import { knownCamera, proxyTarget } from './common';

// Composed clips (cam-proxy spec 2026-09-28): the Downloads modal's calls,
// passed to the camera's cam-proxy with its token.
export const composeRouter = Router();
const JOB = /^[A-Za-z0-9_-]{22}$/;
const NAME = /^[A-Za-z0-9_.-]{1,120}\.mp4$/;

function target(req: Request, res: Response) {
  const t = proxyTarget(req, res);
  return t && { ...t, base: proxyPath(t.id, '/compositions') };
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
// js/request-forgery). Kept a little longer than the proxy keeps a result,
// counted from the last question about the job.
const started = new Map<string, { id: string; at: number }>();
const KEEP_MS = 20 * 60_000;
const keyOf = (cam: string, job: string) => `${cam}\u0000${job}`;
function remember(cam: string, id: string) {
  const t = Date.now();
  for (const [k, v] of started) if (t - v.at > KEEP_MS) started.delete(k);
  started.set(keyOf(cam, id), { id, at: t });
}
// Each question about a job keeps it (the dialog asks once a minute while a
// result is open, issue #76).
function known(cam: string, req: Request, res: Response): string | undefined {
  const entry = started.get(keyOf(cam, String(req.params.job)));
  if (!entry) return void res.status(404).json({ error: 'not_found' }), undefined;
  entry.at = Date.now();
  return entry.id;
}

composeRouter.post('/api/cameras/:id/compositions', async (req, res) => {
  const t = target(req, res);
  if (!t) return;
  const b = (req.body ?? {}) as { eventId?: unknown; at?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown; timeZone?: unknown; dryRun?: unknown };
  if (b.at !== undefined) return void (await around(t, b, res));
  if (typeof b.eventId !== 'string' || !EVENT.test(b.eventId)) return void res.status(400).json({ error: 'invalid', detail: 'eventId is required' });
  try {
    let clip: { id: number; event: { start: number; end: number } } | null;
    try {
      clip = await getRecordings().proxyClipOf(t.id, b.eventId);
    } catch (err) {
      return void lookupFailed(t.id, err, res);
    }
    if (!clip) return void res.status(404).json({ error: 'no_clip' });
    // The dialog's rule and words (server/clipLimits.ts) on the event's own
    // length; the proxy checks again on the same span (its own words).
    if (typeof b.preS === 'number' && typeof b.postS === 'number' && typeof b.size === 'string') {
      const len = resultLength(Math.round((clip.event.end - clip.event.start) / 1000), b.preS, b.postS, generateMaxS(b.size));
      if (!len.ok) return void res.status(400).json({ error: 'invalid', detail: len.error });
    }
    // span: the rolls apply to the event (the SD recording the dialog shows),
    // not to the proxy's FTP copy, which can be longer (2026-10-04: 114 s,
    // pre -100, post 30 was 44 s here and 175 s on the proxy).
    const up = await t.client.open(t.base, undefined, { method: 'POST', body: JSON.stringify({ clipId: clip.id, span: clip.event, preS: b.preS, postS: b.postS, size: b.size, badge: b.badge, ...(typeof b.timeZone === 'string' ? { timeZone: b.timeZone } : {}) }) });
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

// "Save clip around this" (#179 phase 3, spec §5, rulings 14 and 16): a
// window around a second, checked here with the dialog's rule and words, then
// relayed; the proxy plans it from its clips and stills.
const SIZES = ['sd', '360p', '720p', '1080p'];
const AT_MAX_AGE_MS = 8 * 86_400_000; // the proxy keeps 7 days from the start of a UTC day
async function around(t: { id: string; client: ProxyClient; base: string }, b: { eventId?: unknown; at?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown; timeZone?: unknown; dryRun?: unknown }, res: Response) {
  const bad = (detail: string) => void res.status(400).json({ error: 'invalid', detail });
  if (b.eventId !== undefined) return bad('exactly one of eventId or at');
  const at = b.at;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at % 1000 !== 0) return bad('at is a whole second (unix ms)');
  const now = Date.now();
  if (at > now) return bad('at is in the future');
  if (at < now - AT_MAX_AGE_MS) return bad('at is older than the stills and clips kept');
  if (typeof b.size !== 'string' || !SIZES.includes(b.size)) return bad('size is sd, 360p, 720p or 1080p');
  if (typeof b.badge !== 'boolean') return bad('badge is true or false');
  if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') return bad('dryRun is true or false');
  const len = aroundLength(b.preS as number, b.postS as number, b.size);
  if (!len.ok) return bad(len.error);
  const zone = typeof b.timeZone === 'string' && validZone(b.timeZone) ? b.timeZone : undefined;
  try {
    const up = await t.client.open(t.base, undefined, { method: 'POST', body: JSON.stringify({ at, preS: b.preS, postS: b.postS, size: b.size, badge: b.badge, ...(zone ? { timeZone: zone } : {}), ...(b.dryRun ? { dryRun: true } : {}) }) });
    const text = await up.text();
    if (up.status !== 201) {
      res.status(up.status);
      return void (text ? res.type('application/json').send(text) : res.end());
    }
    const job = JSON.parse(text) as { id?: unknown };
    if (typeof job.id === 'string' && JOB.test(job.id)) remember(t.id, job.id);
    res.status(201).json({ ...job, name: `${t.id}-${await stampOf(t.id, at, zone)}-around.mp4` });
  } catch (err) {
    failed(err, res);
  }
}
const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};
// YYYY-MM-DD_HH-MM-SS of `at` in the camera's local time at that moment
// (its time settings and DST rule, as every other save is named, #72); in
// the viewer's zone, else UTC, when the camera can't be asked within 2 s
// (ruling 16).
async function stampOf(cam: string, at: number, zone: string | undefined): Promise<string> {
  let time: TimeInfo;
  try {
    const client = getClient(cam);
    if (!client) throw new Error('no client');
    time = await Promise.race([client.timeInfo(), new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('slow')), 2000).unref())]);
  } catch {
    return zone ? zoneStamp(at, zone) : offsetStamp(at, 0);
  }
  return offsetStamp(at, offsetAt(time, at, zone));
}

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
  const id = knownCamera(req, res);
  if (!id) return;
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
