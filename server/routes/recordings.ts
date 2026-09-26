import { Router, Request, Response, NextFunction } from 'express';
import { getCamera } from '../cameraRegistry';
import { CameraError } from '../reolink/client';
import { logger } from '../logger';
import { CLIP_ID, DATE } from '../recordings/clipNames';
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
  if (!CLIP_ID.test(id)) {
    res.status(400).json({ error: 'bad_request' });
    return undefined;
  }
  return id;
}

recordingsRouter.get('/api/cameras/:id/days', async (req, res, next) => {
  const id = camera(req, res);
  if (!id) return;
  const month = String(req.query.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(month)) {
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
  if (!DATE.test(date)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  try {
    res.json({ date, events: await getRecordings().events(id, date) });
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
    const path = await rec.clipFile(id, clipId);
    const key = rec.videoKey(id, clipId);
    // Review focus 4: the file can't be evicted while it's being served.
    await rec.pinned(key, () => new Promise<void>((resolve) => {
      res.sendFile(path, { headers: { 'Content-Type': 'video/mp4' } }, () => resolve());
    }));
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/thumb.jpg', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  try {
    res.type('image/jpeg').sendFile(await getRecordings().thumbnail(id, clipId));
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/download', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  const quality = req.query.quality === 'main' ? 'main' : 'sub';
  try {
    const { stream, filename, release } = await getRecordings().openDownload(id, clipId, quality);
    res.on('close', () => {
      stream.destroy();
      release();
    });
    res.status(200).set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    stream.pipe(res);
  } catch (err) {
    fail(err, id, res, next);
  }
});
