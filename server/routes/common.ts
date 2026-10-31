import type { NextFunction, Request, Response } from 'express';
import { resolveCamera } from '../cameraRegistry';
import { camsIdOf, type AccountRef, type CamKey } from '../fleet';
import type { Principal } from '../middleware/requireAuth';
import { logger } from '../logger';
import { getProxyClient, ProxyError, type ProxyClient } from '../proxy/client';
import { CameraError } from '../reolink/client';

// Helpers shared by the /api/cameras/:id routers.

// The account a request acts in: the session's (one account in file mode).
// Set by requireAuthApi (res.locals.principal); every /api route but the
// picker's runs behind it.
export function sessionAccount(_req: Request, res: Response): AccountRef {
  const p = res.locals.principal as Principal | undefined;
  if (!p) throw new Error('sessionAccount: no principal (route not behind requireAuthApi)');
  return p.account;
}

// The camera named by :id, resolved within the session's account only (a
// camsId is unique per account); an unknown one is answered 404 here.
export function knownCamera(req: Request, res: Response): CamKey | undefined {
  const id = resolveCamera(sessionAccount(req, res).id, req.params.id); // isolation-ok: resolved within the session's account
  if (id) return id;
  res.status(404).json({ error: 'unknown_camera' });
  return undefined;
}

// The camera named by :id and its cam-proxy client; a camera without a proxy
// in use is answered 404 no_proxy here (undefined).
export function proxyTarget(req: Request, res: Response): { id: CamKey; client: ProxyClient } | undefined {
  const id = knownCamera(req, res);
  if (!id) return undefined;
  const client = getProxyClient(id);
  if (!client) {
    res.status(404).json({ error: 'no_proxy' });
    return undefined;
  }
  return { id, client };
}

// The camera id every JSON answer carries: the camsId (never the key).
export const outId = (key: CamKey): string => camsIdOf(key);

// A CameraError as 502 (the camera refused) or 503 (offline, auth); anything
// else goes to the error handler. Headers already sent: no JSON body can
// follow, so the response is cut.
export function sendCameraError(err: unknown, cameraId: CamKey, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (!(err instanceof CameraError)) {
    next(err);
    return;
  }
  logger.warn({ cameraId, code: err.code, message: err.message }, 'camera_request_failed');
  res.status(err.code === 'camera_error' ? 502 : 503).json({ error: err.code });
}

// res.sendFile as a promise. A client abort surfaces as an error too (headers
// already sent, or the write failed with ECONNABORTED): there's nothing left
// to answer, so it resolves instead of rejecting into the error path.
export function sendFileQuietly(req: Request, res: Response, path: string, opts: { headers?: Record<string, string> } = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    res.sendFile(path, opts, (err) => {
      if (err && !res.headersSent && !req.destroyed && (err as NodeJS.ErrnoException).code !== 'ECONNABORTED') reject(err);
      else resolve();
    });
  });
}

// A request that fails validation: 400 invalid with a detail for the developer.
export const badRequest = (res: Response, detail: string): void => void res.status(400).json({ error: 'invalid', detail });

// A cam-proxy call that failed: 502 proxy_unavailable (or the response cut
// once headers are out), logged as `event` with `fields`. Anything but a
// ProxyError is rethrown; a viewer who already left gets nothing.
export function proxyFailed(err: unknown, res: Response, event: string, fields: Record<string, unknown> = {}): void {
  if (res.destroyed) return;
  if (!(err instanceof ProxyError)) throw err;
  logger.warn({ ...fields, code: err.code, message: err.message }, event);
  if (!res.headersSent) res.status(502).json({ error: 'proxy_unavailable' });
  else res.destroy();
}

// A proxy answer's JSON body; null when it is empty or not JSON.
export async function readJson(up: globalThis.Response): Promise<unknown> {
  const text = await up.text();
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

// A through-proxy camera call that failed (spec §6.1): no admin token here →
// 403 proxy_admin_missing; the proxy says the camera is offline → 503
// camera_offline; anything else → 502 proxy_unavailable (proxyFailed).
export function viaProxyFailed(err: unknown, cameraId: CamKey, res: Response, next: NextFunction): void {
  if (res.destroyed) return;
  if (!(err instanceof ProxyError)) return next(err);
  if (res.headersSent) return void res.destroy();
  if (err.code === 'proxy_admin_missing') return void res.status(403).json({ error: 'proxy_admin_missing' });
  if (err.status === 503 && (err.upstream === 'camera_offline' || err.upstream === 'camera_restarting')) {
    logger.info({ cameraId, code: err.upstream }, 'camera_request_failed');
    return void res.status(503).json({ error: 'camera_offline' });
  }
  proxyFailed(err, res, 'proxy_camera_call_failed', { cameraId });
}
