import { Router, Request, Response, NextFunction } from 'express';
import { pipeline } from 'stream/promises';
import { getCamera } from '../cameraRegistry';
import { getClient } from '../reolink/clients';
import { CameraError } from '../reolink/client';
import { logger } from '../logger';

export const MAX_LIVE_PER_CAMERA = 4;
const liveCounts = new Map<string, number>();

export function liveStreamCount(id: string): number {
  return liveCounts.get(id) ?? 0;
}

export const camerasRouter = Router();

function cameraId(req: Request, res: Response): string | undefined {
  const id = String(req.params.id);
  if (!getCamera(id)) {
    res.status(404).json({ error: 'unknown_camera' });
    return undefined;
  }
  return id;
}

function sendCameraError(err: unknown, cameraIdValue: string, res: Response, next: NextFunction): void {
  if (!(err instanceof CameraError)) {
    next(err);
    return;
  }
  logger.warn({ cameraId: cameraIdValue, code: err.code, message: err.message }, 'camera_request_failed');
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(err.code === 'camera_error' ? 502 : 503).json({ error: err.code });
}

camerasRouter.get('/api/cameras/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  const id = cameraId(req, res);
  if (!id) return;
  try {
    const status = await getClient(id)!.status();
    res.json({ id, online: true, ...status });
  } catch (err) {
    if (!(err instanceof CameraError)) return next(err);
    logger.warn({ cameraId: id, code: err.code, message: err.message }, 'camera_status_failed');
    res.json({ id, online: false, error: err.code });
  }
});

camerasRouter.get('/api/cameras/:id/snapshot.jpg', async (req: Request, res: Response, next: NextFunction) => {
  const id = cameraId(req, res);
  if (!id) return;
  try {
    const jpeg = await getClient(id)!.snapshot();
    res.type('image/jpeg').send(jpeg);
  } catch (err) {
    sendCameraError(err, id, res, next);
  }
});

camerasRouter.get('/api/cameras/:id/live', async (req: Request, res: Response, next: NextFunction) => {
  const id = cameraId(req, res);
  if (!id) return;
  if (liveStreamCount(id) >= MAX_LIVE_PER_CAMERA) {
    res.status(503).json({ error: 'too_many_streams' });
    return;
  }
  const quality = req.query.quality === 'main' ? 'main' : 'sub';
  liveCounts.set(id, liveStreamCount(id) + 1);
  const abort = new AbortController();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    abort.abort();
    liveCounts.set(id, Math.max(0, liveStreamCount(id) - 1));
  };
  res.on('close', release);
  try {
    const upstream = await getClient(id)!.openLive(quality, abort.signal);
    if (abort.signal.aborted) {
      upstream.destroy();
      return;
    }
    res.status(200).set({ 'Content-Type': 'video/x-flv', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await pipeline(upstream, res);
  } catch (err) {
    // The viewer closing the tab ends the pipeline with a premature-close
    // error; that is the normal way a live stream stops.
    if (abort.signal.aborted) return;
    sendCameraError(err, id, res, next);
  } finally {
    release();
  }
});
