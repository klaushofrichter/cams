import { addressEvents, cameraHost, getCamera, hostFromProxy } from '../cameraRegistry';
import { cameraTrust } from '../tls/cameraTrust';
import { trustEvents } from '../tls/store';
import { CameraError, ReolinkClient } from './client';
import type { CamKey } from '../fleet';

// One client per camera for the life of the process, so the token cache and
// the concurrency gate are shared by every request for that camera. A
// from-proxy camera's client is built for the address its proxy reported
// (none yet: every request answers camera_address_unknown), and again when
// that address changes (the token belongs to the old one).
const clients = new Map<CamKey, ReolinkClient>();

addressEvents.on('address', ({ cam }: { cam: CamKey }) => clients.delete(cam));
// Its trust changed (a site CA verified, a fallback pin set or cleared).
trustEvents.on('trust', ({ cam }: { cam: CamKey }) => clients.delete(cam));

// None for a camera without its password here (cams-admin mode, M §9.8).
export function getClient(id: CamKey): ReolinkClient | undefined {
  const existing = clients.get(id);
  if (existing) return existing;
  const cam = getCamera(id);
  if (!cam || cam.credentials !== 'ok') return undefined;
  const client = new ReolinkClient(hostFromProxy(cam) ? { ...cam, host: cameraHost(id) ?? '' } : cam, { trust: cameraTrust(cam) });
  // Not cached while the address is unknown: the next call sees it once reported.
  if (!hostFromProxy(cam) || cameraHost(id)) clients.set(id, client);
  return client;
}

// The camera's client, or a CameraError the routes answer with (503).
export function requireClient(id: CamKey): ReolinkClient {
  const c = getClient(id);
  if (c) return c;
  const cam = getCamera(id);
  throw new CameraError(cam ? 'camera_credentials_missing' : 'camera_offline', cam ? 'no password for the camera here' : 'unknown camera');
}

export function resetClients(): void {
  clients.clear();
}
