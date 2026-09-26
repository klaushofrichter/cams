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
  // Headers already went out: no matter what kind of error this is, a JSON
  // body can no longer be sent and next(err) would try to send one anyway.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (!(err instanceof CameraError)) {
    next(err);
    return;
  }
  logger.warn({ cameraId: cameraIdValue, code: err.code, message: err.message }, 'camera_request_failed');
  res.status(err.code === 'camera_error' ? 502 : 503).json({ error: err.code });
}

// A best-effort label for a stream failure's log line: never the full
// message (which could carry a URL), just the error's code or name.
function errorDetail(err: unknown): string {
  if (err instanceof Error) return (err as NodeJS.ErrnoException).code ?? err.name;
  return 'unknown';
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
  // Once piping starts, a failure on either side of the pipe destroys the
  // other side too (that's what stream.pipeline() is for), so both a viewer
  // disconnect and a camera drop end up closing both `res` and `upstream`.
  // Whichever side's failure happens FIRST is the true cause; `cause` latches
  // on the first of the two events below and is left alone by the second
  // (which is just the automatic, resulting cleanup).
  let cause: 'viewer' | 'camera' | undefined;
  const release = () => {
    if (released) return;
    released = true;
    abort.abort();
    liveCounts.set(id, Math.max(0, liveStreamCount(id) - 1));
  };
  res.on('close', () => {
    if (cause === undefined && !res.writableFinished) cause = 'viewer';
    release();
  });
  try {
    const upstream = await getClient(id)!.openLive(quality, abort.signal);
    if (abort.signal.aborted) {
      upstream.destroy();
      return;
    }
    upstream.once('error', () => {
      if (cause === undefined) cause = 'camera';
    });
    res.status(200).set({ 'Content-Type': 'video/x-flv', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await pipeline(upstream, res);
  } catch (err) {
    // Headers already sent and the camera's own connection is what failed
    // first: log it. A viewer disconnect (cause === 'viewer', or no upstream
    // ever opened) is the normal, quiet way a live stream stops.
    if (res.headersSent && cause === 'camera') {
      logger.warn({ cameraId: id, code: 'stream_interrupted', message: errorDetail(err) }, 'camera_stream_failed');
      res.destroy();
      return;
    }
    if (abort.signal.aborted) return;
    sendCameraError(err, id, res, next);
  } finally {
    release();
  }
});
