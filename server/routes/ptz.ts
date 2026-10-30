import { Router, type Request, type Response } from 'express';
import { proxyPath } from '../proxy/client';
import { badRequest, proxyFailed, proxyTarget } from './common';

// Pan, tilt, zoom and saved positions (cam-proxy spec
// 2026-10-30-ptz-capabilities-design §5, §8.2): every member's calls, checked
// here and passed to the camera's cam-proxy with its token. Only the known
// fields travel; the proxy's status and JSON come back as they are.
export const ptzRouter = Router();

const DIRECTIONS = ['left', 'right', 'up', 'down', 'left-up', 'left-down', 'right-up', 'right-down'];
const LENS = { zoom: ['in', 'out'], focus: ['near', 'far'] } as const;
const CONTROL_TIMEOUT_MS = 5000;

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// The proxy's status and JSON body, as they are.
async function relay(res: Response, up: globalThis.Response): Promise<void> {
  res.status(up.status);
  const text = await up.text();
  if (text) res.type('application/json').send(text);
  else res.end();
}

async function forward(req: Request, res: Response, rest: string, init: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: object; timeoutMs: number }): Promise<void> {
  const t = proxyTarget(req, res);
  if (!t) return;
  try {
    const up = await t.client.open(proxyPath(t.id, rest), undefined, { method: init.method, ...(init.body !== undefined && { body: JSON.stringify(init.body) }), timeoutMs: init.timeoutMs });
    await relay(res, up);
  } catch (err) {
    proxyFailed(err, res, 'ptz_proxy_failed', { cameraId: t.id });
  }
}

// An optional whole number in range; a message when it isn't one.
function optionalInt(b: Record<string, unknown>, name: string, min: number, max: number): string | null {
  return b[name] === undefined || isInt(b[name], min, max) ? null : `${name} must be a whole number from ${min} to ${max}`;
}

const bodyOf = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

ptzRouter.post('/api/cameras/:id/ptz/move', async (req, res) => {
  const b = bodyOf(req);
  if (typeof b.direction !== 'string' || !DIRECTIONS.includes(b.direction)) return badRequest(res, `direction must be one of ${DIRECTIONS.join(', ')}`);
  const problem = optionalInt(b, 'speed', 1, 10) ?? optionalInt(b, 'durationMs', 100, 2000);
  if (problem) return badRequest(res, problem);
  const body = { direction: b.direction, ...(b.speed !== undefined && { speed: b.speed }), ...(b.durationMs !== undefined && { durationMs: b.durationMs }) };
  await forward(req, res, '/ptz/move', { method: 'POST', body, timeoutMs: CONTROL_TIMEOUT_MS });
});

for (const op of ['zoom', 'focus'] as const) {
  ptzRouter.post(`/api/cameras/:id/ptz/${op}`, async (req, res) => {
    const b = bodyOf(req);
    const dirs: readonly string[] = LENS[op];
    if (typeof b.direction !== 'string' || !dirs.includes(b.direction)) return badRequest(res, `direction must be one of ${dirs.join(', ')}`);
    const problem = optionalInt(b, 'durationMs', 100, 2000);
    if (problem) return badRequest(res, problem);
    await forward(req, res, `/ptz/${op}`, { method: 'POST', body: { direction: b.direction, ...(b.durationMs !== undefined && { durationMs: b.durationMs }) }, timeoutMs: CONTROL_TIMEOUT_MS });
  });
}

ptzRouter.post('/api/cameras/:id/ptz/stop', async (req, res) => {
  await forward(req, res, '/ptz/stop', { method: 'POST', body: {}, timeoutMs: CONTROL_TIMEOUT_MS });
});

// --- saved positions (spec §5.2) ---------------------------------------------
const POSITIONS_TIMEOUT_MS = 15_000; // a save writes the camera's preset and reads it back
// The proxy's ids are pos_…; checked so only path-safe ids travel.
const POS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 40;

// A name a person typed: trimmed, 1–40 characters, no control characters.
function nameOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  const n = [...name].length;
  // cam-proxy's class (src/ptz/positions.ts): C0, DEL and C1 only, so format
  // characters such as an emoji's zero-width joiner stay allowed.
  // eslint-disable-next-line no-control-regex
  return n >= 1 && n <= NAME_MAX && !/[\u0000-\u001f\u007f-\u009f]/.test(name) ? name : null;
}
const NAME_RULE = `name must be 1 to ${NAME_MAX} characters, without control characters`;

// The position id in the path, or undefined once answered 400.
function posIdOf(req: Request, res: Response): string | undefined {
  const id = String(req.params.posId);
  if (POS_ID.test(id)) return id;
  badRequest(res, 'unknown position id');
  return undefined;
}

ptzRouter.get('/api/cameras/:id/ptz/positions', async (req, res) => {
  await forward(req, res, '/ptz/positions', { method: 'GET', timeoutMs: POSITIONS_TIMEOUT_MS });
});

ptzRouter.post('/api/cameras/:id/ptz/positions', async (req, res) => {
  const name = nameOf(bodyOf(req).name);
  if (name === null) return badRequest(res, NAME_RULE);
  await forward(req, res, '/ptz/positions', { method: 'POST', body: { name }, timeoutMs: POSITIONS_TIMEOUT_MS });
});

// Only PUT uses `order`, so it never meets PATCH/DELETE …/positions/:posId.
ptzRouter.put('/api/cameras/:id/ptz/positions/order', async (req, res) => {
  const ids = bodyOf(req).ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || !ids.every((x) => typeof x === 'string' && POS_ID.test(x)) || new Set(ids).size !== ids.length) {
    return badRequest(res, 'ids must list every position once');
  }
  await forward(req, res, '/ptz/positions/order', { method: 'PUT', body: { ids }, timeoutMs: POSITIONS_TIMEOUT_MS });
});

ptzRouter.patch('/api/cameras/:id/ptz/positions/:posId', async (req, res) => {
  const id = posIdOf(req, res);
  if (!id) return;
  const b = bodyOf(req);
  if (b.name === undefined && b.home === undefined) return badRequest(res, 'name or home is required');
  if (b.home !== undefined && b.home !== true) return badRequest(res, 'home is only ever set to true');
  const name = b.name === undefined ? undefined : nameOf(b.name);
  if (name === null) return badRequest(res, NAME_RULE);
  await forward(req, res, `/ptz/positions/${id}`, { method: 'PATCH', body: { ...(name !== undefined && { name }), ...(b.home === true && { home: true }) }, timeoutMs: POSITIONS_TIMEOUT_MS });
});

for (const op of ['save', 'go'] as const) {
  ptzRouter.post(`/api/cameras/:id/ptz/positions/:posId/${op}`, async (req, res) => {
    const id = posIdOf(req, res);
    if (!id) return;
    await forward(req, res, `/ptz/positions/${id}/${op}`, { method: 'POST', timeoutMs: POSITIONS_TIMEOUT_MS });
  });
}

ptzRouter.delete('/api/cameras/:id/ptz/positions/:posId', async (req, res) => {
  const id = posIdOf(req, res);
  if (!id) return;
  await forward(req, res, `/ptz/positions/${id}`, { method: 'DELETE', timeoutMs: POSITIONS_TIMEOUT_MS });
});
