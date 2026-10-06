import { Router, Request, Response } from 'express';
import { getCamera, proxyActive, setReportedName } from '../cameraRegistry';
import { cameraNameProblem, cameraRefusalReason } from '../cameraName';
import { logger } from '../logger';
import { currentUser } from '../middleware/requireAuth';
import { errorBody, groupTrustOptions, ProxyClient, ProxyError } from '../proxy/client';
import { plausibleName } from '../proxy/names';
import { CameraError } from '../reolink/client';
import { getClient } from '../reolink/clients';
import { knownCamera } from './common';

// Renaming a camera (design camera-name-design.md): the camera stores the
// name, every signed-in user may change it. A camera whose cam-proxy is in
// use is renamed through the proxy (PUT /control/camera/name with its admin
// token); any other camera directly (SetDevName, the whole object, then
// GetDevName). Either way the answer is the name read back from the camera:
//   200 {name}   400 {error: 'invalid_name', reason}   503 {error: 'camera_offline'}
//   502 {error: 'proxy_unavailable' | 'camera_error'}
export const nameRouter = Router();

const PROXY_TIMEOUT_MS = 20_000; // the proxy writes, then re-reads the camera

type Answer = { status: number; body: Record<string, unknown> };
const invalid = (reason: string): Answer => ({ status: 400, body: { error: 'invalid_name', reason } });

async function viaProxy(id: string, proxy: { url: string; adminToken: string }, name: string): Promise<Answer> {
  let res: globalThis.Response;
  try {
    res = await new ProxyClient({ url: proxy.url, token: proxy.adminToken }, { timeoutMs: PROXY_TIMEOUT_MS, ...groupTrustOptions(id) }).open('/control/camera/name', undefined, { method: 'PUT', body: JSON.stringify({ name }) });
  } catch (err) {
    if (!(err instanceof ProxyError)) throw err;
    logger.warn({ cameraId: id, code: err.code, message: err.message }, 'camera_rename_failed');
    return { status: 502, body: { error: 'proxy_unavailable' } };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
    if (plausibleName(body?.name)) return { status: 200, body: { name: body.name } };
    logger.warn({ cameraId: id, status: res.status }, 'camera_rename_bad_answer');
    return { status: 502, body: { error: 'proxy_unavailable' } };
  }
  const { error, reason } = await errorBody(res);
  if (res.status === 400) return invalid(reason ?? cameraRefusalReason(undefined));
  if (res.status === 503 && (error === 'camera_offline' || error === undefined)) return { status: 503, body: { error: 'camera_offline' } };
  // Another camera failure behind the proxy (its 502 camera_error).
  if (res.status === 502 && error === 'camera_error') {
    logger.warn({ cameraId: id, status: res.status, upstream: error }, 'camera_rename_failed');
    return { status: 502, body: { error: 'camera_error' } };
  }
  logger.warn({ cameraId: id, status: res.status, upstream: error }, 'camera_rename_failed');
  return { status: 502, body: { error: 'proxy_unavailable' } };
}

// SetDevName with the whole DevName object (only `name` replaced), then
// GetDevName: the firmware may answer 200 to a write it ignored.
async function direct(id: string, name: string): Promise<Answer> {
  const client = getClient(id)!;
  const read = async () => ((await client.command<{ DevName?: Record<string, unknown> }>('GetDevName', { channel: 0 })).DevName ?? {}) as Record<string, unknown>;
  try {
    const before = await read();
    await client.command('SetDevName', { DevName: { ...before, name } });
    const after = await read();
    if (!plausibleName(after.name)) return { status: 502, body: { error: 'camera_error' } };
    return { status: 200, body: { name: after.name } };
  } catch (err) {
    if (!(err instanceof CameraError)) throw err;
    if (err.code === 'camera_error' && (err.rspCode === -54 || err.rspCode === -56)) return invalid(cameraRefusalReason(err.rspCode));
    logger.warn({ cameraId: id, code: err.code, message: err.message }, 'camera_rename_failed');
    return err.code === 'camera_error' ? { status: 502, body: { error: 'camera_error' } } : { status: 503, body: { error: 'camera_offline' } };
  }
}

nameRouter.put('/api/cameras/:id/name', async (req: Request, res: Response) => {
  const id = knownCamera(req, res);
  if (!id) return;
  const body = req.body as unknown;
  const name = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { name?: unknown }).name : undefined;
  const problem = cameraNameProblem(name);
  if (problem) return void res.status(400).json({ error: 'invalid_name', reason: problem });
  const proxy = getCamera(id)!.proxy;
  const via = proxy?.adminToken && proxyActive(id) ? 'proxy' : 'camera';
  const answer = via === 'proxy' ? await viaProxy(id, { url: proxy!.url, adminToken: proxy!.adminToken! }, name as string) : await direct(id, name as string);
  if (answer.status === 200) {
    setReportedName(id, answer.body.name as string);
    logger.info({ cameraId: id, via, by: currentUser(req)?.email }, 'camera_renamed');
  }
  res.status(answer.status).json(answer.body);
});
