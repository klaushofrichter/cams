import type { NextFunction, Request, Response } from 'express';
import { getCamera } from '../cameraRegistry';
import { logger } from '../logger';
import { getProxyClient, type ProxyClient } from '../proxy/client';
import { CameraError } from '../reolink/client';

// Helpers shared by the /api/cameras/:id routers.

// The camera named by :id; an unknown one is answered 404 here (undefined).
export function knownCamera(req: Request, res: Response): string | undefined {
  const id = String(req.params.id);
  if (getCamera(id)) return id;
  res.status(404).json({ error: 'unknown_camera' });
  return undefined;
}

// The camera named by :id and its cam-proxy client; a camera without a proxy
// in use is answered 404 no_proxy here (undefined).
export function proxyTarget(req: Request, res: Response): { id: string; client: ProxyClient } | undefined {
  const id = knownCamera(req, res);
  if (!id) return undefined;
  const client = getProxyClient(id);
  if (!client) {
    res.status(404).json({ error: 'no_proxy' });
    return undefined;
  }
  return { id, client };
}

// A CameraError as 502 (the camera refused) or 503 (offline, auth); anything
// else goes to the error handler. Headers already sent: no JSON body can
// follow, so the response is cut.
export function sendCameraError(err: unknown, cameraId: string, res: Response, next: NextFunction): void {
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
