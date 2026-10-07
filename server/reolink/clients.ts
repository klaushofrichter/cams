import { addressEvents, cameraHost, getCamera, hostFromProxy, type CameraConfig } from '../cameraRegistry';
import { groupOf } from '../proxy/groups';
import { cameraEndpoint, secretAllowed, secretGuardOn } from '../secretGuard';
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
  if (!cam || cam.credentials !== 'ok' || passwordBlocked(cam)) return undefined;
  const client = new ReolinkClient(hostFromProxy(cam) ? { ...cam, host: cameraHost(id) ?? '' } : cam, { trust: cameraTrust(cam) });
  // Not cached while the address is unknown: the next call sees it once reported.
  if (!hostFromProxy(cam) || cameraHost(id)) clients.set(id, client);
  return client;
}

// cams-admin mode (the guard on): the password goes only to the camera
// endpoint an admin confirmed, and never over TLS nothing verifies.
function passwordBlocked(cam: CameraConfig): 'camera_unconfirmed' | 'camera_unverified_tls' | null {
  if (!secretGuardOn()) return null;
  const pins = groupOf(cam.id)?.pins ?? null;
  if (!secretAllowed(cam.password, cameraEndpoint({ protocol: cam.protocol, host: cam.host, tlsServername: cam.tlsServername ?? null, pins }))) return 'camera_unconfirmed';
  if (cam.protocol === 'https' && cameraTrust(cam).kind === 'none') return 'camera_unverified_tls';
  return null;
}

// The camera's client, or a CameraError the routes answer with (503).
export function requireClient(id: CamKey): ReolinkClient {
  const c = getClient(id);
  if (c) return c;
  const cam = getCamera(id);
  if (!cam) throw new CameraError('camera_offline', 'unknown camera');
  if (cam.credentials === 'unconfirmed') throw new CameraError('camera_unconfirmed', 'the camera\'s connection data is not confirmed');
  if (cam.credentials !== 'ok') throw new CameraError('camera_credentials_missing', 'no password for the camera here');
  const blocked = passwordBlocked(cam);
  throw new CameraError(blocked ?? 'camera_offline', 'the password is not sent to this endpoint');
}

export function resetClients(): void {
  clients.clear();
}
