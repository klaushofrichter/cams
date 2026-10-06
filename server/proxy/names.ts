import { getCamera, setReportedAddress, setReportedName } from '../cameraRegistry';
import { logger } from '../logger';
import { applyProxyTls } from '../tls/cameraTrust';
import { getProxyClient } from './client';
import { entryOf, readProxyList, type ProxyCameraEntry } from './cameraList';
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

// The camera's entry in the proxy's camera list (no answer, no entry: undefined).
async function readProxyEntry(id: string, timeoutMs: number): Promise<ProxyCameraEntry | undefined> {
  if (!getProxyClient(id)) return undefined;
  try {
    return entryOf(id, await readProxyList(id, timeoutMs));
  } catch (err) {
    logger.debug({ cameraId: id, message: (err as Error).message }, 'proxy_name_unread');
    return undefined;
  }
}

// The name in the proxy's camera list, or undefined (no answer, no entry).
export async function readProxyName(id: string, timeoutMs = 5000): Promise<string | undefined> {
  const mine = await readProxyEntry(id, timeoutMs);
  return plausibleName(mine?.name) ? mine.name : undefined;
}

// The name and, for a "from-proxy" camera, its address (spec
// 2026-10-04-camera-address-from-proxy-design): read when the stream comes up.
export async function refreshProxyName(id: string): Promise<void> {
  const mine = await readProxyEntry(id, 5000);
  // The stream may have gone down (or the proxy been switched off) meanwhile.
  if (!mine || !proxyStates().some((s) => s.cam === id && s.up)) return;
  if (plausibleName(mine.name)) setReportedName(id, mine.name);
  setReportedAddress(id, mine.address);
  await applyProxyTls(id, mine.tls);
}

// The list is read again while the stream stays up, so a camera replaced
// meanwhile gets its new pin (and name) without a restart.
const REFRESH_MS = 15 * 60_000;
let refreshMs = REFRESH_MS;
const refreshTimers = new Map<string, NodeJS.Timeout>();
// Tests: a shorter interval (no argument: the default again).
export function setListRefreshMs(ms = REFRESH_MS): void {
  refreshMs = ms;
}

proxyHub.on('state', (s: { cam: string; up: boolean }) => {
  if (!getCamera(s.cam)?.proxy) return;
  clearTimeout(downTimers.get(s.cam));
  downTimers.delete(s.cam);
  clearInterval(refreshTimers.get(s.cam));
  refreshTimers.delete(s.cam);
  if (s.up) {
    const timer = setInterval(() => void refreshProxyName(s.cam), refreshMs);
    timer.unref();
    refreshTimers.set(s.cam, timer);
    return void refreshProxyName(s.cam);
  }
  const timer = setTimeout(() => {
    downTimers.delete(s.cam);
    setReportedName(s.cam, null);
  }, graceMs);
  timer.unref();
  downTimers.set(s.cam, timer);
});

proxyHub.on('message', (m: { cam: string; type: string; data: Record<string, unknown> }) => {
  if (m.type !== 'camera') return;
  if (plausibleName(m.data.name)) setReportedName(m.cam, m.data.name);
  // cam-proxy's `camera` message carries the address too (it may carry only that).
  if (m.data.address !== undefined) setReportedAddress(m.cam, m.data.address);
});
