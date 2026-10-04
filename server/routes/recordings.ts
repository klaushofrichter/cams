import { Router, Request, Response, NextFunction } from 'express';
import { getProxyClient } from '../proxy/client';
import { getAnalysisStore } from '../proxy/analyses';
import { attachAnalyses } from '../recordings/analysis';
import { getAiEventStore } from '../proxy/aiEvents';
import { attachCounts } from '../recordings/detection';
import { pipeline } from 'stream/promises';
import { formatSeconds, PLAIN_MAX_S } from '../clipLimits';
import { clipDate, clipSeconds, CLIP_ID, isRealDate, isRealMonth } from '../recordings/clipNames';
import { getRecordings } from '../recordings/service';
import { RecordingError } from '../recordings/errors';
import { extent } from '../recordings/extent';
import { knownCamera, sendCameraError, sendFileQuietly } from './common';

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
  sendCameraError(err, cameraId, res, next);
}

function clip(req: Request, res: Response): string | undefined {
  const id = String(req.params.clipId);
  if (!CLIP_ID.test(id) || !isRealDate(clipDate(id))) {
    res.status(400).json({ error: 'bad_request' });
    return undefined;
  }
  return id;
}

recordingsRouter.get('/api/cameras/:id/days', async (req, res, next) => {
  const id = knownCamera(req, res);
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

// How far back the camera's content goes (the History strip's left edge),
// and its oldest still (the Timeline's one-second steps, issue #159).
recordingsRouter.get('/api/cameras/:id/extent', async (req, res, next) => {
  const id = knownCamera(req, res);
  if (!id) return;
  try {
    res.json(await extent(id));
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/events', async (req, res, next) => {
  const id = knownCamera(req, res);
  if (!id) return;
  const date = String(req.query.date ?? '');
  if (!isRealDate(date)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  // A viewer who leaves mid-list stops holding the proxy's busy wait.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) gone.abort();
  });
  try {
    const rec = getRecordings();
    const events = await rec.events(id, date, gone.signal);
    rec.probeIfDue(id, events.at(-1)?.id);
    // cam-proxy's Vision results on the cards (spec 2026-09-30-analytics-in-cams-design),
    // and how many person, vehicle and pet events each holds (Klaus, 2026-10-04).
    let shown: typeof events = events;
    if (getProxyClient(id)) {
      const [analyses, ai] = await Promise.all([getAnalysisStore().forDay(id, date, events), getAiEventStore().forDay(id, date, events)]);
      shown = attachCounts(attachAnalyses(events, analyses), ai);
    }
    res.json({ date, events: shown, downloads: rec.downloadsState(id) });
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/video', async (req, res, next) => {
  const id = knownCamera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  const rec = getRecordings();
  try {
    // Review focus: the file is pinned from before fill() starts (inside
    // withClip), so it can never be evicted while it's being served here.
    await rec.withClip(id, clipId, (path) => sendFileQuietly(req, res, path, { headers: { 'Content-Type': 'video/mp4' } }));
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/thumb.jpg', async (req, res, next) => {
  const id = knownCamera(req, res);
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
    await getRecordings().withThumbnail(id, clipId, (path) => sendFileQuietly(req, res.type('image/jpeg'), path));
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/download', async (req, res, next) => {
  const id = knownCamera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  const q = req.query.quality;
  if (q !== undefined && q !== 'sub' && q !== 'main') {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const quality = q === 'main' ? 'main' : 'sub';
  // A plain save is up to PLAIN_MAX_S (Klaus, 2026-10-04); the Save dialog
  // offers no longer one, so this only answers a hand-made link.
  if (clipSeconds(clipId) > PLAIN_MAX_S) return void res.status(400).json({ error: 'too_long', detail: `At most ${formatSeconds(PLAIN_MAX_S)}` });
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

// Whether a 4K (main) download can be served now (Klaus, 2026-10-02: no
// silent quality downgrade). The Save dialog asks when 4K is chosen; an
// unknown clip is simply not available.
recordingsRouter.get('/api/cameras/:id/clips/:clipId/full-quality', async (req, res, next) => {
  const id = knownCamera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  try {
    res.json({ available: await getRecordings().mainAvailable(id, clipId) });
  } catch (err) {
    if (err instanceof RecordingError && err.code === 'unknown_clip') return void res.json({ available: false });
    fail(err, id, res, next);
  }
});
