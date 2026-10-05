import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { normalizeLabels, nameProblem, QUALITIES, retentionProblem, SORT_KEYS, sortItems, type SortKey, type SortOrder } from '../archiveRules';
import { getCamera } from '../cameraRegistry';
import { logger } from '../logger';
import { currentUser } from '../middleware/requireAuth';
import { createArchiveRateLimit } from '../middleware/rateLimit';
import { archiveProxies, archiveProxy, JOB_ID, onBehalfOf, parseItem, parseJob, parseMetadata, parseStatus, proxyOfCamera, refusal, type ArchiveItem, type ArchiveProxy } from '../proxy/archive';
import { ProxyError } from '../proxy/client';
import { CLIP_ID } from '../recordings/clipNames';
import { RecordingError } from '../recordings/errors';
import { getRecordings } from '../recordings/service';
import { startedComposition } from './compose';
import { knownCamera } from './common';
import { relayImage } from './proxy';

// The Archive (cam-proxy's archive contract, docs/archive.md there; cams spec
// 2026-10-05-archive-design): every call relayed to the camera's cam-proxy
// with its client token, server-side only. The person goes along as
// X-On-Behalf-Of on writes. Ids and job ids are parsed or cams's own copies:
// no request value becomes a proxy path unchecked (CodeQL js/request-forgery).
export const archiveRouter = Router();

const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });
const who = (req: Request) => onBehalfOf(currentUser(req)?.email);
// The statuses the contract answers with; anything else is the gateway failing.
const PASSED = new Set([400, 404, 409, 429, 503, 507]);
// A job that failed at once (contract §2): 507, 503, 404, 502 fetch_failed, 500 store_failed, 409.
const FAILED_STATUS = new Set([404, 409, 500, 502, 503, 507]);

function failed(err: unknown, res: Response, what: string): void {
  if (res.destroyed) return;
  if (!(err instanceof ProxyError)) throw err;
  logger.warn({ code: err.code, message: err.message, what }, 'archive_proxy_failed');
  if (!res.headersSent) res.status(502).json({ error: 'proxy_unavailable' });
  else res.destroy();
}

async function readJson(up: globalThis.Response): Promise<unknown> {
  const t = await up.text();
  try {
    return t ? (JSON.parse(t) as unknown) : null;
  } catch {
    return null;
  }
}

// A refused request as the browser gets it: the contract's statuses and fields.
function sendRefusal(status: number, body: unknown, res: Response): void {
  if (PASSED.has(status)) return void res.status(status).json(refusal(body));
  res.status(502).json({ error: 'proxy_unavailable' });
}
async function passRefusal(up: globalThis.Response, res: Response): Promise<void> {
  sendRefusal(up.status, await readJson(up), res);
}

// The editable fields of a create or a PATCH, checked: name (trimmed),
// labels (normalized) and retention, each only when given; or the problem.
function editFields(b: { name?: unknown; labels?: unknown; retentionDays?: unknown }): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const p = nameProblem(b.name);
    if (p) return p;
    out.name = (b.name as string).trim();
  }
  if (b.labels !== undefined) {
    const l = normalizeLabels(b.labels);
    if (!l.ok) return l.error;
    out.labels = l.labels;
  }
  if (b.retentionDays !== undefined) {
    const p = retentionProblem(b.retentionDays);
    if (p) return p;
    out.retentionDays = b.retentionDays;
  }
  return out;
}

// The proxy named by :via (a cams camera that reaches it), or 404.
function proxyOf(req: Request, res: Response): ArchiveProxy | undefined {
  const p = archiveProxy(String(req.params.via));
  if (!p) res.status(404).json({ error: 'unknown_archive' });
  return p;
}
// :id as a number (the proxy path is built from it), or 400.
function itemId(req: Request, res: Response): number | undefined {
  const s = String(req.params.id);
  if (!/^\d{1,12}$/.test(s) || Number(s) < 1) return void bad(res, 'an item id is a whole number');
  return Number(s);
}

// --- Create (contract §2) ---------------------------------------------------

// The jobs cams started, with cams's own copy of the proxy's id: only those
// are polled or cancelled. Kept as long as the proxy keeps a finished job.
const jobs = new Map<string, { id: string; at: number }>();
const KEEP_MS = 20 * 60_000;
const jobKey = (via: string, id: string) => `${via}\u0000${id}`;
function remember(via: string, id: string) {
  const now = Date.now();
  for (const [k, v] of jobs) if (now - v.at > KEEP_MS) jobs.delete(k);
  jobs.set(jobKey(via, id), { id, at: now });
}

type CreateBody = { source?: { type?: unknown; id?: unknown; eventId?: unknown; quality?: unknown }; name?: unknown; labels?: unknown; retentionDays?: unknown; thumbnailAt?: unknown };

archiveRouter.post('/api/cameras/:id/archive', createArchiveRateLimit('create'), async (req: Request, res: Response) => {
  const cam = knownCamera(req, res);
  if (!cam) return;
  const target = proxyOfCamera(cam);
  if (!target) return void res.status(404).json({ error: 'no_proxy' });
  const b = (req.body ?? {}) as CreateBody;
  const out = editFields(b);
  if (typeof out === 'string') return bad(res, out);
  if (b.thumbnailAt !== undefined) {
    if (!Number.isSafeInteger(b.thumbnailAt) || (b.thumbnailAt as number) < 0) return bad(res, 'thumbnailAt is unix ms');
    out.thumbnailAt = b.thumbnailAt;
  }
  const s = b.source ?? {};
  if (s.type === 'composition') {
    // Only a composition cams started for this camera, by cams's own copy of its id.
    const job = typeof s.id === 'string' && JOB_ID.test(s.id) ? startedComposition(cam, s.id) : undefined;
    if (!job) return void res.status(404).json({ error: 'not_found', detail: 'no such composition' });
    out.source = { type: 'composition', id: job };
  } else if (s.type === 'event') {
    // A plain save (SD or 4K as recorded): the file the download would serve.
    if (typeof s.eventId !== 'string' || !CLIP_ID.test(s.eventId)) return bad(res, 'eventId is a recording');
    if (s.quality !== 'sub' && s.quality !== 'main') return bad(res, 'quality is sub or main');
    try {
      const src = await getRecordings().archiveSource(cam, s.eventId, s.quality);
      if (!src) return void res.status(409).json({ error: s.quality === 'main' ? 'full_quality_unavailable' : 'no_recording' });
      out.source = src;
    } catch (err) {
      if (err instanceof RecordingError && err.code === 'unknown_clip') return void res.status(404).json({ error: 'unknown_recording' });
      logger.warn({ cameraId: cam, message: (err as Error).message }, 'archive_source_failed');
      return void res.status(502).json({ error: 'proxy_unavailable' });
    }
  } else return bad(res, 'source is a composition or an event');
  try {
    // The proxy waits up to 3 s for the job before answering 202.
    const up = await target.proxy.client.open(`/api/cameras/${encodeURIComponent(target.remote)}/archive`, undefined, { method: 'POST', body: JSON.stringify(out), headers: who(req), timeoutMs: 30_000 });
    logger.info({ cameraId: cam, status: up.status, source: (out.source as { type: string }).type, by: currentUser(req)?.email }, 'archive_requested');
    if (up.status !== 201 && up.status !== 202) {
      // A job that failed within the proxy's 3 s answers with its error's
      // status and the job as the body (contract §2): its code and words.
      const body = await readJson(up);
      const failedJob = parseJob(body, target.proxy);
      if (failedJob?.state === 'failed' || failedJob?.state === 'cancelled') {
        const status = FAILED_STATUS.has(up.status) ? up.status : 502;
        return void res.status(status).json({ ...refusal(body), error: failedJob.error ?? 'store_failed', ...(failedJob.detail ? { detail: failedJob.detail } : {}) });
      }
      return sendRefusal(up.status, body, res);
    }
    const job = parseJob(await readJson(up), target.proxy);
    if (!job) return void res.status(502).json({ error: 'proxy_unavailable' });
    remember(target.proxy.via, job.id);
    res.status(up.status).json(job);
  } catch (err) {
    failed(err, res, 'create');
  }
});

function knownJob(req: Request, res: Response, p: ArchiveProxy): string | undefined {
  const e = jobs.get(jobKey(p.via, String(req.params.job)));
  if (!e) return void res.status(404).json({ error: 'not_found' });
  e.at = Date.now();
  return e.id;
}

archiveRouter.get('/api/archive/:via/jobs/:job', async (req, res) => {
  const p = proxyOf(req, res);
  const job = p && knownJob(req, res, p);
  if (!p || !job) return;
  try {
    const up = await p.client.open(`/api/archive/jobs/${job}`);
    if (!up.ok) return void (await passRefusal(up, res));
    const j = parseJob(await readJson(up), p);
    if (!j) return void res.status(502).json({ error: 'proxy_unavailable' });
    res.json(j);
  } catch (err) {
    failed(err, res, 'job');
  }
});

archiveRouter.delete('/api/archive/:via/jobs/:job', async (req, res) => {
  const p = proxyOf(req, res);
  const job = p && knownJob(req, res, p);
  if (!p || !job) return;
  try {
    const up = await p.client.open(`/api/archive/jobs/${job}`, undefined, { method: 'DELETE', headers: who(req) });
    if (up.status === 204) return void res.status(204).end();
    await passRefusal(up, res);
  } catch (err) {
    failed(err, res, 'cancel');
  }
});

// --- List (contract §3) -----------------------------------------------------

const PAGE = 500;
const MAX_PAGES = 20; // 10 000 clips per proxy
const LABELS = /^[A-Za-z0-9]{1,24}(,[A-Za-z0-9]{1,24}){0,15}$/;

export interface ProxyState {
  via: string;
  cams: string[];
  ok: boolean;
  error?: 'too_old' | 'unreachable' | 'error';
}

function listQuery(req: Request): { query: Record<string, string>; sort: SortKey; order: SortOrder; cam?: string } | string {
  const q = req.query;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined);
  const query: Record<string, string> = {};
  const sort = one('sort') ?? 'created';
  if (!(SORT_KEYS as readonly string[]).includes(sort)) return `sort is one of ${SORT_KEYS.join(', ')}`;
  const order = one('order') ?? 'desc';
  if (order !== 'asc' && order !== 'desc') return 'order is asc or desc';
  query.sort = sort;
  query.order = order;
  const labels = one('labels');
  if (labels !== undefined && labels !== '') {
    if (!LABELS.test(labels)) return 'labels is a comma-separated list of labels';
    query.labels = labels;
  }
  const text = one('q');
  if (text !== undefined && text !== '') {
    if (text.length > 120 || /[\u0000-\u001f\u007f]/.test(text)) return 'q is up to 120 characters';
    query.q = text;
  }
  const quality = one('quality');
  if (quality !== undefined && quality !== '') {
    if (!quality.split(',').every((x) => (QUALITIES as readonly string[]).includes(x))) return `quality is a comma-separated list of ${QUALITIES.join(', ')}`;
    query.quality = quality;
  }
  for (const k of ['from', 'to']) {
    const v = one(k);
    if (v === undefined || v === '') continue;
    if (!/^\d{1,15}$/.test(v)) return `${k} is unix ms`;
    query[k] = v;
  }
  const cam = one('cam');
  if (cam !== undefined && cam !== '' && !getCamera(cam)) return 'cam is a camera';
  return { query, sort: sort as SortKey, order, cam: cam || undefined };
}

async function listProxy(p: ArchiveProxy, query: Record<string, string>): Promise<{ items: ArchiveItem[]; total: number; state: ProxyState }> {
  const state: ProxyState = { via: p.via, cams: p.cams, ok: true };
  const items: ArchiveItem[] = [];
  let total = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await p.client.json<{ total?: unknown; items?: unknown }>('/api/archive', { ...query, limit: PAGE, offset: page * PAGE });
      const list = Array.isArray(body?.items) ? body.items : [];
      total = Number.isSafeInteger(body?.total) ? (body.total as number) : list.length;
      for (const x of list) {
        const it = parseItem(x, p);
        if (it) items.push(it);
      }
      if (list.length < PAGE || (page + 1) * PAGE >= total) break;
    }
  } catch (err) {
    // An older cam-proxy has no archive: every path is its 404 not_found.
    state.ok = false;
    state.error = err instanceof ProxyError && err.status === 404 ? 'too_old' : err instanceof ProxyError && err.code !== 'proxy_error' ? 'unreachable' : 'error';
    if (state.error !== 'too_old') logger.warn({ via: p.via, message: (err as Error).message }, 'archive_list_failed');
  }
  return { items, total, state };
}

// Every proxy's archive, merged in the proxies' own order (the same sort
// key, then recorded and id descending; contract §3).
archiveRouter.get('/api/archive', async (req, res) => {
  const q = listQuery(req);
  if (typeof q === 'string') return bad(res, q);
  let proxies = archiveProxies();
  if (q.cam) proxies = proxies.filter((p) => p.cams.includes(q.cam!));
  const lists = await Promise.all(
    proxies.map((p) => {
      const remote = q.cam ? [...p.toCams].find(([, c]) => c === q.cam)?.[0] : undefined;
      return listProxy(p, remote ? { ...q.query, cam: remote } : q.query);
    }),
  );
  const items = sortItems(lists.flatMap((l) => l.items), q.sort, q.order);
  res.json({ total: lists.reduce((n, l) => n + l.total, 0), items, proxies: lists.map((l) => l.state) });
});

// Each proxy's status (contract §6).
archiveRouter.get('/api/archive/status', async (_req, res) => {
  const out = await Promise.all(
    archiveProxies().map(async (p) => {
      try {
        const s = parseStatus(await p.client.json<unknown>('/api/archive/status'));
        return s ? { via: p.via, cams: p.cams, ok: true, ...s } : { via: p.via, cams: p.cams, ok: false, error: 'error' };
      } catch (err) {
        return { via: p.via, cams: p.cams, ok: false, error: err instanceof ProxyError && err.status === 404 ? 'too_old' : 'unreachable' };
      }
    }),
  );
  res.json(out);
});

// --- One item (contract §4) -------------------------------------------------

archiveRouter.get('/api/archive/:via/items/:id', async (req, res) => {
  const p = proxyOf(req, res);
  const id = p && itemId(req, res);
  if (!p || !id) return;
  try {
    const up = await p.client.open(`/api/archive/${id}`);
    if (!up.ok) return void (await passRefusal(up, res));
    const it = parseItem(await readJson(up), p);
    if (!it) return void res.status(502).json({ error: 'proxy_unavailable' });
    res.json(it);
  } catch (err) {
    failed(err, res, 'item');
  }
});

archiveRouter.patch('/api/archive/:via/items/:id', async (req, res) => {
  const p = proxyOf(req, res);
  const id = p && itemId(req, res);
  if (!p || !id) return;
  const b = (req.body ?? {}) as { name?: unknown; labels?: unknown; retentionDays?: unknown };
  const out = editFields(b);
  if (typeof out === 'string') return bad(res, out);
  if (!Object.keys(out).length) return bad(res, 'name, labels or retentionDays');
  try {
    const up = await p.client.open(`/api/archive/${id}`, undefined, { method: 'PATCH', body: JSON.stringify(out), headers: who(req) });
    if (!up.ok) return void (await passRefusal(up, res));
    const it = parseItem(await readJson(up), p);
    if (!it) return void res.status(502).json({ error: 'proxy_unavailable' });
    res.json(it);
  } catch (err) {
    failed(err, res, 'patch');
  }
});

archiveRouter.delete('/api/archive/:via/items/:id', async (req, res) => {
  const p = proxyOf(req, res);
  const id = p && itemId(req, res);
  if (!p || !id) return;
  try {
    const up = await p.client.open(`/api/archive/${id}`, undefined, { method: 'DELETE', headers: who(req) });
    if (up.status === 204) return void res.status(204).end();
    await passRefusal(up, res);
  } catch (err) {
    failed(err, res, 'delete');
  }
});

// A list of ids from the body or the query: whole numbers, at most `max`.
function idList(v: unknown, max: number): number[] | string {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((x) => (/^\d{1,12}$/.test(x) ? Number(x) : NaN)) : null;
  if (!raw || raw.length < 1 || raw.length > max) return `ids is a list of 1 to ${max} ids`;
  if (!raw.every((x) => Number.isSafeInteger(x) && (x as number) >= 1)) return 'an id is a whole number';
  return [...new Set(raw as number[])];
}

archiveRouter.post('/api/archive/:via/delete', async (req, res) => {
  const p = proxyOf(req, res);
  if (!p) return;
  const ids = idList((req.body as { ids?: unknown } | undefined)?.ids, 500);
  if (typeof ids === 'string') return bad(res, ids);
  try {
    const up = await p.client.open('/api/archive/delete', undefined, { method: 'POST', body: JSON.stringify({ ids }), headers: who(req) });
    if (!up.ok) return void (await passRefusal(up, res));
    const b = ((await readJson(up)) ?? {}) as { deleted?: unknown; notFound?: unknown };
    const ints = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x)) : []);
    res.json({ deleted: ints(b.deleted), notFound: ints(b.notFound) });
  } catch (err) {
    failed(err, res, 'bulk-delete');
  }
});

// Aborted when the viewer goes away, so a proxy request still waiting for its
// headers (a large ZIP being planned) is let go at once, not at its timeout.
function viewerGone(res: Response): AbortSignal {
  const ctl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctl.abort(new Error('viewer left'));
  });
  return ctl.signal;
}

// Streams the proxy's body as it comes (never buffered); a viewer who leaves
// cancels the upstream request.
async function stream(up: globalThis.Response, req: Request, res: Response): Promise<void> {
  try {
    await pipeline(Readable.fromWeb(up.body as import('stream/web').ReadableStream), res);
  } catch (err) {
    if (req.destroyed || res.destroyed) return; // the viewer left, or the proxy cut it: the response is cut
    throw err;
  }
}
const header = (up: globalThis.Response, name: string, re: RegExp) => {
  const v = up.headers.get(name);
  return v && re.test(v) ? v : undefined;
};
// An attachment name as cam-proxy sends it (contract §4, §5): a quoted ASCII
// name and maybe an RFC 5987 one. The header as sent and its ASCII name, or
// undefined when it isn't that form. One check for the video and the ZIP.
const DISPOSITION = /^attachment; filename="([\x20\x21\x23-\x5b\x5d-\x7e]{1,200})"(; filename\*=UTF-8''[A-Za-z0-9!#$&+.^_`|~%-]{1,1000})?$/;
function attachment(up: globalThis.Response): { header: string; name: string } | undefined {
  const v = up.headers.get('content-disposition');
  const m = v ? DISPOSITION.exec(v) : null;
  return m ? { header: v!, name: m[1] } : undefined;
}

archiveRouter.get('/api/archive/:via/items/:id/video', async (req, res) => {
  const p = proxyOf(req, res);
  const id = p && itemId(req, res);
  if (!p || !id) return;
  const download = req.query.download === '1';
  // Byte ranges pass through: players seek with them, iOS plays only with them.
  const range = req.get('range');
  try {
    const up = await p.client.open(`/api/archive/${id}/video`, download ? { download: 1 } : undefined, { signal: viewerGone(res), idleMs: 30_000, headers: range && /^bytes=\d{0,15}-\d{0,15}$/.test(range) ? { Range: range } : {} });
    if (up.status === 416) {
      await up.body?.cancel();
      const cr = header(up, 'content-range', /^bytes \*\/\d{1,15}$/);
      return void res.status(416).set(cr ? { 'Content-Range': cr } : {}).end();
    }
    if ((up.status !== 200 && up.status !== 206) || !up.body) return void (await passRefusal(up, res));
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=604800, immutable' };
    const len = header(up, 'content-length', /^\d{1,15}$/);
    if (len) headers['Content-Length'] = len;
    const cr = header(up, 'content-range', /^bytes \d{1,15}-\d{1,15}\/\d{1,15}$/);
    if (cr && up.status === 206) headers['Content-Range'] = cr;
    const etag = header(up, 'etag', /^(W\/)?"[A-Za-z0-9._:-]{1,128}"$/);
    if (etag) headers.ETag = etag;
    if (download) {
      headers['Content-Disposition'] = attachment(up)?.header ?? `attachment; filename="archive-${id}.mp4"`;
      headers['Cache-Control'] = 'no-store'; // the name follows a rename: never a cached download
    }
    res.status(up.status).set(headers);
    await stream(up, req, res);
  } catch (err) {
    failed(err, res, 'video');
  }
});

archiveRouter.get('/api/archive/:via/items/:id/thumbnail', async (req, res) => {
  const p = proxyOf(req, res);
  const id = p && itemId(req, res);
  if (!p || !id) return;
  try {
    await relayImage(res, p.client, `/api/archive/${id}/thumbnail`, () => ({ 'Cache-Control': 'private, max-age=604800, immutable' }), viewerGone(res));
  } catch (err) {
    failed(err, res, 'thumbnail');
  }
});

archiveRouter.get('/api/archive/:via/items/:id/metadata', async (req, res) => {
  const p = proxyOf(req, res);
  const id = p && itemId(req, res);
  if (!p || !id) return;
  try {
    const up = await p.client.open(`/api/archive/${id}/metadata`);
    if (!up.ok) return void (await passRefusal(up, res));
    const m = parseMetadata(await readJson(up), p, id);
    if (!m) return void res.status(502).json({ error: 'proxy_unavailable' });
    res.json(m);
  } catch (err) {
    failed(err, res, 'metadata');
  }
});

// --- ZIP (contract §5) ------------------------------------------------------

// The ZIP's name is cams's own: archive-<camera>-<YYYYMMDD-HHMMSS>.zip.
// cam-proxy names it after its own id of the first clip's camera, which two
// proxies may share (both "cam1"): cams puts its own id for that camera
// instead, else the camera it reaches the proxy through (`via`); both are
// unique across proxies. The time is the proxy's, from its name, else
// cams's clock (UTC).
const ZIP_NAME = /^archive-([A-Za-z0-9_-]{1,64})-(\d{8}-\d{6})\.zip$/;
function zipName(p: Pick<ArchiveProxy, 'via' | 'toCams'>, proxyName: string | undefined, now = new Date()): string {
  const m = proxyName ? ZIP_NAME.exec(proxyName) : null;
  const cam = (m && p.toCams.get(m[1])) || p.via;
  const time = m?.[2] ?? now.toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
  return `archive-${cam.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}-${time}.zip`;
}
archiveRouter.get('/api/archive/:via/zip', createArchiveRateLimit('zip'), async (req, res) => {
  const p = proxyOf(req, res);
  if (!p) return;
  const ids = idList(req.query.ids, 200);
  if (typeof ids === 'string') return bad(res, ids);
  try {
    // A ZIP of many 4K clips takes long: no idle cut while the proxy sends.
    const up = await p.client.open('/api/archive/zip', { ids: ids.join(',') }, { signal: viewerGone(res), idleMs: 60_000, timeoutMs: 60_000 });
    if (!up.ok || !up.body) return void (await passRefusal(up, res));
    const headers: Record<string, string> = { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName(p, attachment(up)?.name)}"` };
    const len = header(up, 'content-length', /^\d{1,15}$/);
    if (len) headers['Content-Length'] = len;
    res.status(200).set(headers);
    await stream(up, req, res);
  } catch (err) {
    failed(err, res, 'zip');
  }
});
