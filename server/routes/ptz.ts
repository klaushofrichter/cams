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
