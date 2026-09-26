import { getCamera } from '../cameraRegistry';
import { ReolinkClient } from './client';

// One client per camera for the life of the process, so the token cache and
// the concurrency gate are shared by every request for that camera.
const clients = new Map<string, ReolinkClient>();

export function getClient(id: string): ReolinkClient | undefined {
  const existing = clients.get(id);
  if (existing) return existing;
  const cam = getCamera(id);
  if (!cam) return undefined;
  const client = new ReolinkClient(cam);
  clients.set(id, client);
  return client;
}

export function resetClients(): void {
  clients.clear();
}
