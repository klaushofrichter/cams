import { Router, type Request, type Response } from 'express';
import { logger } from '../logger';
import { currentUser } from '../middleware/requireAuth';
import { createCheckRateLimits } from '../middleware/rateLimit';
import { proxyPath, ProxyError } from '../proxy/client';
import { parseCheck, parseFullCheck, parseUsage, type StillCheck } from '../proxy/stillChecks';
import { outId, proxyTarget } from './common';
import { relayImage } from './proxy';
import type { CamKey } from '../fleet';

// Still checks (cams #179, spec 2026-10-04-still-checks-ui-design): Vision on
// a second picked on the Timeline, through the camera's cam-proxy with its
// client token. Every answer is rebuilt from parsed fields: no proxy URL, no
// `raw`, nothing the proxy sent unchecked.
export const stillChecksRouter = Router();

const DAY = 86_400_000;
const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });
const base = (id: CamKey) => `/api/cameras/${encodeURIComponent(outId(id))}/still-checks`;

// A check as the browser gets it: cams's own image URL, from the parsed id.
const out = (id: CamKey, c: StillCheck, extra: Record<string, unknown> = {}) => ({
  id: c.id,
  eventId: c.eventId,
  stillTs: c.stillTs,
  provider: c.provider,
  summary: c.summary,
  events: c.events,
  imageUrl: c.id !== null && c.image ? `${base(id)}/${c.id}.jpg` : null,
  ...extra,
});

// The proxy's refusal, with only the fields the contract names, each checked.
const CODE = /^[a-z_]{1,32}$/;
function refusal(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as { error?: unknown; reason?: unknown; until?: unknown; detail?: unknown };
  return {
    error: typeof b.error === 'string' && CODE.test(b.error) ? b.error : 'proxy_error',
    ...(typeof b.reason === 'string' && /^[a-z0-9_]{1,32}$/.test(b.reason) ? { reason: b.reason } : {}),
    ...(Number.isSafeInteger(b.until) ? { until: b.until } : b.until === null ? { until: null } : {}),
    ...(typeof b.detail === 'string' ? { detail: b.detail.slice(0, 160) } : {}),
  };
}
// The statuses the contract answers with; anything else is the gateway failing.
const PASSED = new Set([400, 404, 409, 429, 500, 502, 503]);

function failed(err: unknown, id: CamKey, res: Response): void {
  if (res.destroyed) return;
  if (!(err instanceof ProxyError)) throw err;
  logger.warn({ cameraId: id, code: err.code, message: err.message }, 'still_check_proxy_failed');
  if (!res.headersSent) res.status(502).json({ error: 'proxy_unavailable' });
  else res.destroy();
}

async function readJson(up: globalThis.Response): Promise<unknown> {
  const text = await up.text();
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

// Check a second. The proxy answers a stored check (200, reused), a new one
// (201) or why not; cams logs who asked (the proxy knows only its token).
stillChecksRouter.post('/api/cameras/:id/still-checks', ...createCheckRateLimits(), async (req: Request, res: Response) => {
  const at = (req.body as { at?: unknown } | undefined)?.at;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return bad(res, 'at is a whole number (unix ms)');
  if (at % 1000 !== 0) return bad(res, 'at is a whole second');
  if (at > Date.now()) return bad(res, 'at is in the future');
  const t = proxyTarget(req, res);
  if (!t) return;
  try {
    // The proxy waits up to 10 s for Vision, maybe behind a call for the same second.
    const up = await t.client.open(proxyPath(t.id, '/still-checks'), undefined, { method: 'POST', body: JSON.stringify({ at }), timeoutMs: 30_000 });
    const body = (await readJson(up)) as { reused?: unknown; source?: unknown; check?: unknown } | null;
    logger.info({ cameraId: t.id, at, status: up.status, error: up.ok ? undefined : refusal(body).error, by: currentUser(req)?.email }, 'still_check_requested');
    if (up.status === 200 || up.status === 201) {
      const check = parseFullCheck(body?.check);
      if (!check) return void res.status(502).json({ error: 'proxy_unavailable' });
      const source = body?.source === 'event' || body?.source === 'check' ? body.source : undefined;
      return void res.status(up.status).json({ reused: body?.reused === true, ...(source ? { source } : {}), check: out(t.id, check, { objects: check.objects, requestedAt: check.requestedAt, tookMs: check.tookMs }) });
    }
    // An older proxy has no still checks: every path is its 404 not_found.
    if (up.status === 404 && refusal(body).error === 'not_found') return void res.status(404).json({ error: 'too_old' });
    res.status(PASSED.has(up.status) ? up.status : 502).json(PASSED.has(up.status) ? refusal(body) : { error: 'proxy_unavailable' });
  } catch (err) {
    failed(err, t.id, res);
  }
});

// The checks of a range (the Timeline's day), oldest first. An older proxy: none.
stillChecksRouter.get('/api/cameras/:id/still-checks', async (req: Request, res: Response) => {
  const from = String(req.query.from ?? ''), to = String(req.query.to ?? '');
  if (!/^\d{1,15}$/.test(from) || !/^\d{1,15}$/.test(to) || Number(to) < Number(from)) return bad(res, 'from and to (unix ms) are required');
  if (Number(to) - Number(from) > 31 * DAY) return bad(res, 'at most 31 days per request');
  const t = proxyTarget(req, res);
  if (!t) return;
  try {
    const list = await t.client.json<unknown>(proxyPath(t.id, '/still-checks'), { from: Number(from), to: Number(to) });
    res.json((Array.isArray(list) ? list : []).map(parseCheck).filter((c): c is StillCheck => c !== null).map((c) => out(t.id, c)));
  } catch (err) {
    if (err instanceof ProxyError && err.status === 404 && !res.headersSent) return void res.json([]);
    failed(err, t.id, res);
  }
});

// One check in full (its objects for "Show all objects"), or its image.
stillChecksRouter.get('/api/cameras/:id/still-checks/:file', async (req: Request, res: Response) => {
  const m = /^(\d{1,12})(\.jpg)?$/.exec(String(req.params.file));
  if (!m) return bad(res, 'a check is <id>, its image <id>.jpg');
  const t = proxyTarget(req, res);
  if (!t) return;
  // The proxy path is built from the parsed number, never the raw parameter.
  const checkId = Number(m[1]);
  try {
    if (m[2]) {
      return void (await relayImage(res, t.client, proxyPath(t.id, `/still-checks/${checkId}.jpg`), () => ({ 'Cache-Control': 'private, max-age=604800, immutable' })));
    }
    const check = parseFullCheck(await t.client.json<unknown>(proxyPath(t.id, `/still-checks/${checkId}`)));
    if (!check) return void res.status(502).json({ error: 'proxy_unavailable' });
    res.json(out(t.id, check, { objects: check.objects, requestedAt: check.requestedAt, tookMs: check.tookMs }));
  } catch (err) {
    if (err instanceof ProxyError && err.status === 404 && !res.headersSent) return void res.status(404).json({ error: 'not_found' });
    failed(err, t.id, res);
  }
});

// The budget for the button: on, paused, this month's and today's calls and
// checks. Never a key. An older proxy: 404 too_old.
stillChecksRouter.get('/api/cameras/:id/analytics', async (req: Request, res: Response) => {
  const t = proxyTarget(req, res);
  if (!t) return;
  try {
    res.json(parseUsage(await t.client.json<unknown>(proxyPath(t.id, '/analytics'))));
  } catch (err) {
    if (err instanceof ProxyError && err.status === 404 && !res.headersSent) return void res.status(404).json({ error: 'too_old' });
    failed(err, t.id, res);
  }
});
