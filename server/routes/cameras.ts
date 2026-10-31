import { Router, Request, Response, NextFunction } from 'express';
import { pipeline } from 'stream/promises';
import { requireClient } from '../reolink/clients';
import { CameraError } from '../reolink/client';
import { logger } from '../logger';
import { proxyActive, setReportedName } from '../cameraRegistry';
import { plausibleName } from '../proxy/names';
import { knownCamera, outId, sendCameraError, viaProxyFailed } from './common';
import { throughProxy } from '../proxy/features';
import { readProxyStatus, type ProxyCameraStatus } from '../proxy/cameraCalls';
import { getCamera } from '../cameraRegistry';
import { ProxyError, proxyPath, requireProxyClient } from '../proxy/client';
import { nodeBody } from '../httpBody';
import type { CamKey } from '../fleet';

export const MAX_LIVE_PER_CAMERA = 4;
// Per camera: the responses of its open live streams.
const liveStreams = new Map<CamKey, Set<Response>>();

export function liveStreamCount(id: CamKey): number {
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
const offlineSince = new Map<CamKey, number>();

// Why a through-proxy camera is offline, the first that applies (spec §6.2).
function proxyOfflineError(s: ProxyCameraStatus): string {
  if (s.credentials.source === 'none') return 'camera_credentials_missing';
  if (s.credentials.authOk === false) return 'camera_auth_failed';
  if (s.tls.problem === 'untrusted') return 'camera_untrusted';
  if (s.tls.problem === 'changed') return 'camera_cert_changed';
  return 'camera_offline';
}

// What an admin can do about it from cams: enter the camera's password, or
// trust the certificate the proxy measured (never a typed fingerprint).
function proxyFix(id: CamKey, s: ProxyCameraStatus | null): { login: 'missing' | 'refused' | null; trust: { fingerprint: string } | null; canFix: boolean } {
  const login = !s ? null : s.credentials.source === 'none' ? 'missing' : s.credentials.authOk === false ? 'refused' : null;
  const trust = s?.tls.problem && s.tls.served ? { fingerprint: s.tls.served } : null;
  return { login, trust, canFix: !!getCamera(id)?.proxy?.adminToken };
}

// A camera reached through its proxy only: the proxy's status; the proxy down is the camera offline (no direct try).
async function statusViaProxy(id: CamKey, res: Response): Promise<void> {
  let s: ProxyCameraStatus | null = null;
  let error: string;
  try {
    s = await readProxyStatus(id, { timeoutMs: 10_000 });
    if (s.online) {
      offlineSince.delete(id);
      res.json({ id: outId(id), online: true, model: s.model, firmware: s.firmware, simulator: s.simulator, streams: s.streams, via: 'proxy' });
      return;
    }
    error = proxyOfflineError(s);
  } catch (err) {
    if (!(err instanceof ProxyError)) throw err;
    logger.warn({ cameraId: id, code: err.code, message: err.message }, 'camera_status_failed');
    error = 'proxy_unreachable';
  }
  if (!offlineSince.has(id)) offlineSince.set(id, Date.now());
  res.json({ id: outId(id), online: false, error, offlineSince: offlineSince.get(id), via: 'proxy', fix: proxyFix(id, s) });
}

camerasRouter.get('/api/cameras/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  const id = knownCamera(req, res);
  if (!id) return;
  if (throughProxy(id)) return statusViaProxy(id, res).catch(next);
  try {
    const { name, ...status } = await requireClient(id).status();
    offlineSince.delete(id);
    // A camera without a cam-proxy in use: cams reads its name itself (the
    // page shows it from /api/cameras and the event stream).
    if (!proxyActive(id) && plausibleName(name)) setReportedName(id, name);
    res.json({ id: outId(id), online: true, ...status });
  } catch (err) {
    if (!(err instanceof CameraError)) return next(err);
    logger.warn({ cameraId: id, code: err.code, message: err.message }, 'camera_status_failed');
    if (!offlineSince.has(id)) offlineSince.set(id, Date.now());
    res.json({ id: outId(id), online: false, error: err.code, offlineSince: offlineSince.get(id) });
  }
});

camerasRouter.get('/api/cameras/:id/snapshot.jpg', async (req: Request, res: Response, next: NextFunction) => {
  const id = knownCamera(req, res);
  if (!id) return;
  if (throughProxy(id)) {
    // The proxy's full-size snapshot (the camera's Snap), streamed.
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());
    try {
      const up = await requireProxyClient(id).open(proxyPath(id, '/snapshot.jpg'), { stream: 'main' }, { idleMs: 10_000, signal: ctl.signal, timeoutMs: 20_000 });
      if (!up.ok || !up.body) {
        const body = (await up.json().catch(() => null)) as { error?: unknown } | null;
        return void res.status(up.status === 503 && body?.error === 'camera_offline' ? 503 : 502).json({ error: up.status === 503 && body?.error === 'camera_offline' ? 'camera_offline' : 'proxy_unavailable' });
      }
      res.status(200).set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      await pipeline(nodeBody(up), res);
    } catch (err) {
      if (ctl.signal.aborted) return;
      viaProxyFailed(err, id, res, next);
    }
    return;
  }
  try {
    const jpeg = await requireClient(id).snapshot();
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
    const upstream = await requireClient(id).openLive(quality, abort.signal);
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
