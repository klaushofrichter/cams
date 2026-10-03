import { Router, Request, Response, NextFunction } from 'express';
import { pipeline } from 'stream/promises';
import { getClient } from '../reolink/clients';
import { CameraError } from '../reolink/client';
import { logger } from '../logger';
import { knownCamera, sendCameraError } from './common';

export const MAX_LIVE_PER_CAMERA = 4;
// Per camera: the responses of its open live streams.
const liveStreams = new Map<string, Set<Response>>();

export function liveStreamCount(id: string): number {
  return liveStreams.get(id)?.size ?? 0;
}

export const camerasRouter = Router();

// A best-effort label for a stream failure's log line: never the full
// message (which could carry a URL), just the error's code or name.
function errorDetail(err: unknown): string {
  if (err instanceof Error) return (err as NodeJS.ErrnoException).code ?? err.name;
  return 'unknown';
}

// Since when each camera has been found offline (issue #69: the Live panel
// says so); forgotten when it answers again.
const offlineSince = new Map<string, number>();

camerasRouter.get('/api/cameras/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  const id = knownCamera(req, res);
  if (!id) return;
  try {
    const status = await getClient(id)!.status();
    offlineSince.delete(id);
    res.json({ id, online: true, ...status });
  } catch (err) {
    if (!(err instanceof CameraError)) return next(err);
    logger.warn({ cameraId: id, code: err.code, message: err.message }, 'camera_status_failed');
    if (!offlineSince.has(id)) offlineSince.set(id, Date.now());
    res.json({ id, online: false, error: err.code, offlineSince: offlineSince.get(id) });
  }
});

camerasRouter.get('/api/cameras/:id/snapshot.jpg', async (req: Request, res: Response, next: NextFunction) => {
  const id = knownCamera(req, res);
  if (!id) return;
  try {
    const jpeg = await getClient(id)!.snapshot();
    res.type('image/jpeg').send(jpeg);
  } catch (err) {
    sendCameraError(err, id, res, next);
  }
});

camerasRouter.get('/api/cameras/:id/live', async (req: Request, res: Response, next: NextFunction) => {
  const id = knownCamera(req, res);
  if (!id) return;
  if (liveStreamCount(id) >= MAX_LIVE_PER_CAMERA) {
    res.status(503).json({ error: 'too_many_streams' });
    return;
  }
  const quality = req.query.quality === 'main' ? 'main' : 'sub';
  const open = liveStreams.get(id) ?? new Set<Response>();
  liveStreams.set(id, open.add(res));
  const abort = new AbortController();
  // Once piping starts, a failure on either side of the pipe destroys the
  // other side too (that's what stream.pipeline() is for), so both a viewer
  // disconnect and a camera drop end up closing both `res` and `upstream`.
  // Whichever side's failure happens FIRST is the true cause; `cause` latches
  // on the first of the two events below and is left alone by the second
  // (which is just the automatic, resulting cleanup).
  let cause: 'viewer' | 'camera' | undefined;
  const release = () => {
    abort.abort();
    open.delete(res);
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
