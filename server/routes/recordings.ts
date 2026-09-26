import { Router, Request, Response, NextFunction } from 'express';
import { pipeline } from 'stream/promises';
import { getCamera } from '../cameraRegistry';
import { CameraError } from '../reolink/client';
import { logger } from '../logger';
import { CLIP_ID, isRealDate, isRealMonth } from '../recordings/clipNames';
import { getRecordings, RecordingError } from '../recordings/service';

export const recordingsRouter = Router();

function fail(err: unknown, cameraId: string, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof RecordingError) {
    res.status(err.code === 'unknown_clip' ? 404 : 503).json({ error: err.code });
    return;
  }
  if (err instanceof CameraError) {
    logger.warn({ cameraId, code: err.code, message: err.message }, 'camera_request_failed');
    res.status(err.code === 'camera_error' ? 502 : 503).json({ error: err.code });
    return;
  }
  next(err);
}

function camera(req: Request, res: Response): string | undefined {
  const id = String(req.params.id);
  if (!getCamera(id)) {
    res.status(404).json({ error: 'unknown_camera' });
    return undefined;
  }
  return id;
}

function clip(req: Request, res: Response): string | undefined {
  const id = String(req.params.clipId);
  if (!CLIP_ID.test(id) || !isRealDate(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`)) {
    res.status(400).json({ error: 'bad_request' });
    return undefined;
  }
  return id;
}

recordingsRouter.get('/api/cameras/:id/days', async (req, res, next) => {
  const id = camera(req, res);
  if (!id) return;
  const month = String(req.query.month ?? '');
  if (!isRealMonth(month)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  try {
    res.json({ days: await getRecordings().days(id, month) });
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/events', async (req, res, next) => {
  const id = camera(req, res);
  if (!id) return;
  const date = String(req.query.date ?? '');
  if (!isRealDate(date)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  try {
    const rec = getRecordings();
    res.json({ date, events: await rec.events(id, date), downloads: rec.downloadsState(id) });
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/video', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  const rec = getRecordings();
  try {
    // Review focus: the file is pinned from before fill() starts (inside
    // withClip), so it can never be evicted while it's being served here.
    await rec.withClip(id, clipId, (path) =>
      new Promise<void>((resolve, reject) => {
        res.sendFile(path, { headers: { 'Content-Type': 'video/mp4' } }, (err) => {
          // A client abort surfaces here too (headers already sent, or the
          // write failed with ECONNABORTED): there's nothing left to answer,
          // so just resolve instead of rejecting into fail()'s error path.
          if (err && !res.headersSent && !req.destroyed && (err as NodeJS.ErrnoException).code !== 'ECONNABORTED') reject(err);
          else resolve();
        });
      }),
    );
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/thumb.jpg', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  try {
    // Set Content-Type only once thumbnail() has actually succeeded: Express's
    // res.json() (used by fail() below) skips setting Content-Type when one
    // is already present, so setting it to image/jpeg up front would leave a
    // thumbnail_unavailable error body mislabeled as an image.
    //
    // Pinned (via withThumbnail) from before fill() starts until sendFile()
    // finishes, so it can never be evicted while it's being served here.
    await getRecordings().withThumbnail(id, clipId, (path) =>
      new Promise<void>((resolve, reject) => {
        res.type('image/jpeg').sendFile(path, (err) => {
          if (err && !res.headersSent && !req.destroyed && (err as NodeJS.ErrnoException).code !== 'ECONNABORTED') reject(err);
          else resolve();
        });
      }),
    );
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/download', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  const q = req.query.quality;
  if (q !== undefined && q !== 'sub' && q !== 'main') {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const quality = q === 'main' ? 'main' : 'sub';
  // Registered before openDownload() is called, so an abort mid-acquire (a
  // camera slot still queued) or mid-transfer both cancel cleanly rather
  // than leaking the slot or crashing on an unhandled stream error.
  const abort = new AbortController();
  const onClose = () => abort.abort();
  req.on('close', onClose);
  res.on('close', onClose);
  try {
    const { stream, filename, size } = await getRecordings().openDownload(id, clipId, quality, abort.signal);
    if (abort.signal.aborted) {
      stream.destroy();
      return;
    }
    res.status(200).set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...(size != null ? { 'Content-Length': String(size) } : {}),
    });
    await pipeline(stream, res);
  } catch (err) {
    // A viewer disconnect or a camera drop both end up here (pipeline()
    // destroys both sides of the pipe on either failure); the abort signal
    // tells the two apart. A disconnect is the ordinary, quiet way a
    // download stops - nothing to answer.
    if (abort.signal.aborted) return;
    fail(err, id, res, next);
  } finally {
    req.off('close', onClose);
    res.off('close', onClose);
  }
});
