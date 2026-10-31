import { Router, Request, Response, NextFunction } from 'express';
import { pipeline } from 'stream/promises';
import { requireClient } from '../reolink/clients';
import { CameraError } from '../reolink/client';
import { logger } from '../logger';
import { proxyActive, setReportedName } from '../cameraRegistry';
import { plausibleName } from '../proxy/names';
import { badRequest, knownCamera, outId, sendCameraError, viaProxyFailed } from './common';
import { LIVE_CODECS, openProxyLive, type ProxyLive } from '../proxy/live';
import { throughProxy } from '../proxy/features';
import { PROXY_FINGERPRINT, proxyAdminClient, readProxyStatus, type ProxyCameraStatus } from '../proxy/cameraCalls';
import { currentUser } from '../middleware/requireAuth';
import { readJson } from './common';
import { proxyCameraId } from '../proxy/client';
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

// A viewer that stops reading is cut once this much waits in its response
// (spec §10.3: the proxy cuts cams at 8 MiB; cams cuts a viewer before that).
export const LIVE_MAX_QUEUED = 4 * 1024 * 1024;

// A camera reached through its proxy only: the proxy's live WebSocket (MSE,
// fMP4) relayed as chunked HTTP, the same per-camera slot and route as FLV.
async function liveViaProxy(id: CamKey, req: Request, res: Response, next: NextFunction): Promise<void> {
  const codecs = req.query.codecs;
  if (codecs !== undefined && (typeof codecs !== 'string' || !LIVE_CODECS.test(codecs))) return badRequest(res, 'codecs: a comma list of codec names');
  if (liveStreamCount(id) >= MAX_LIVE_PER_CAMERA) return void res.status(503).json({ error: 'too_many_streams' });
  const quality = req.query.quality === 'main' ? 'main' : 'sub';
  const open = liveStreams.get(id) ?? new Set<Response>();
  liveStreams.set(id, open.add(res));
  const abort = new AbortController();
  let live: ProxyLive | undefined;
  const release = () => {
    abort.abort();
    live?.close();
    open.delete(res);
  };
  res.on('close', release);
  try {
    live = await openProxyLive(id, quality, codecs, abort.signal);
    if (abort.signal.aborted) return;
    res.status(200).set({ 'Content-Type': live.mime, 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    for await (const chunk of live.chunks) {
      if (res.destroyed) break;
      res.write(chunk);
      if (res.writableLength > LIVE_MAX_QUEUED) {
        logger.warn({ cameraId: id, code: 'slow_viewer' }, 'camera_stream_failed');
        res.destroy();
        break;
      }
    }
    if (!res.destroyed) res.end();
  } catch (err) {
    if (abort.signal.aborted && !res.headersSent) return;
    if (res.headersSent) return void res.destroy();
    // The proxy's own refusal before any byte (camera offline, restarting, no stream, too many).
    if (err instanceof ProxyError && err.code === 'proxy_error' && err.status === 503 && err.upstream) {
      logger.info({ cameraId: id, code: err.upstream }, 'camera_stream_refused');
      return void res.status(503).json({ error: err.upstream });
    }
    viaProxyFailed(err, id, res, next);
  } finally {
    release();
  }
}

camerasRouter.get('/api/cameras/:id/live', async (req: Request, res: Response, next: NextFunction) => {
  const id = knownCamera(req, res);
  if (!id) return;
  if (throughProxy(id)) return liveViaProxy(id, req, res, next);
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

// "Trust this camera's certificate" (spec §6.2, §10.2): the fingerprint the
// proxy measured, shown in the dialog, pinned by the proxy with the
// proxy-admin token. cams reads the proxy's status again first; the proxy
// checks once more against what the camera serves (the last word).
camerasRouter.post('/api/cameras/:id/trust', async (req: Request, res: Response, next: NextFunction) => {
  const id = knownCamera(req, res);
  if (!id) return;
  if (!throughProxy(id)) return void res.status(404).json({ error: 'not_through_proxy' });
  const fingerprint = (req.body as { fingerprint?: unknown } | undefined)?.fingerprint;
  if (typeof fingerprint !== 'string' || !PROXY_FINGERPRINT.test(fingerprint)) return badRequest(res, 'fingerprint: SHA256: and 64 upper-case hex digits, as the proxy reported it');
  const by = currentUser(req)?.email;
  const done = (outcome: string) => logger.info({ cameraId: id, outcome, by }, 'camera_trust_relayed');
  try {
    const admin = proxyAdminClient(id);
    const served = (await readProxyStatus(id, { timeoutMs: 10_000 })).tls.served;
    if (served !== fingerprint) {
      done('fingerprint_changed');
      return void res.status(409).json({ error: 'fingerprint_changed', fingerprint: served });
    }
    const up = await admin.open(`/control/cameras/${encodeURIComponent(proxyCameraId(id))}/actions/camera-trust-pin`, undefined, { method: 'POST', body: JSON.stringify({ fingerprint }), timeoutMs: 20_000 });
    const body = (await readJson(up)) as { error?: unknown; served?: unknown } | null;
    if (up.ok) {
      done('pinned');
      return void res.json({ mode: 'pinned' });
    }
    if (up.status === 409 && body?.error === 'fingerprint_mismatch') {
      done('fingerprint_changed');
      return void res.status(409).json({ error: 'fingerprint_changed', fingerprint: typeof body.served === 'string' && PROXY_FINGERPRINT.test(body.served) ? body.served : null });
    }
    if (up.status === 503) {
      done('camera_offline');
      return void res.status(503).json({ error: 'camera_offline' });
    }
    if (up.status === 409 && body?.error === 'not_available') {
      done('not_available');
      return void res.status(409).json({ error: 'not_available' });
    }
    done('proxy_error');
    logger.warn({ cameraId: id, status: up.status }, 'camera_trust_relay_failed');
    res.status(502).json({ error: 'proxy_unavailable' });
  } catch (err) {
    done('proxy_unavailable');
    viaProxyFailed(err, id, res, next);
  }
});
