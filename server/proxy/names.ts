import { getCamera, setReportedName } from '../cameraRegistry';
import { logger } from '../logger';
import { getProxyClient, proxyCameraId } from './client';
import { proxyHub, proxyStates } from './stream';

// A camera's name from its cam-proxy (design camera-name-design.md): the
// proxy's camera info `name` (GET /api/cameras, what the camera reports),
// read whenever the proxy's stream comes up, and its `camera` stream
// message {cam, name} on every change. The last name stays through a proxy
// restart or a blip; after GRACE of the proxy being down, or at once when it
// is switched off, the registry name is shown again.

const GRACE_MS = 120_000;
let graceMs = GRACE_MS;
const downTimers = new Map<string, NodeJS.Timeout>();

// Tests: a shorter grace period (no argument: the default again).
export function setNameGraceMs(ms = GRACE_MS): void {
  graceMs = ms;
}

// The registry name again now (the proxy was switched off).
export function forgetProxyName(id: string): void {
  clearTimeout(downTimers.get(id));
  downTimers.delete(id);
  setReportedName(id, null);
}

// Shown as text only; still bounded, and without control characters.
export const plausibleName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64 && !/\p{C}/u.test(v);

// The name in the proxy's camera list, or undefined (no answer, no entry).
export async function readProxyName(id: string, timeoutMs = 5000): Promise<string | undefined> {
  const client = getProxyClient(id);
  if (!client) return undefined;
  try {
    const list = await client.json<unknown>('/api/cameras', undefined, { timeoutMs });
    const mine = Array.isArray(list) ? (list as { id?: unknown; name?: unknown }[]).find((c) => c?.id === proxyCameraId(id)) : undefined;
    return plausibleName(mine?.name) ? mine.name : undefined;
  } catch (err) {
    logger.debug({ cameraId: id, message: (err as Error).message }, 'proxy_name_unread');
    return undefined;
  }
}

export async function refreshProxyName(id: string): Promise<void> {
  const name = await readProxyName(id);
  // The stream may have gone down (or the proxy been switched off) meanwhile.
  if (name !== undefined && proxyStates().some((s) => s.cam === id && s.up)) setReportedName(id, name);
}

proxyHub.on('state', (s: { cam: string; up: boolean }) => {
  if (!getCamera(s.cam)?.proxy) return;
  clearTimeout(downTimers.get(s.cam));
  downTimers.delete(s.cam);
  if (s.up) return void refreshProxyName(s.cam);
  const timer = setTimeout(() => {
    downTimers.delete(s.cam);
    setReportedName(s.cam, null);
  }, graceMs);
  timer.unref();
  downTimers.set(s.cam, timer);
});

proxyHub.on('message', (m: { cam: string; type: string; data: Record<string, unknown> }) => {
  if (m.type === 'camera' && plausibleName(m.data.name)) setReportedName(m.cam, m.data.name);
});
