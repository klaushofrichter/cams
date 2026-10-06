import { allCameras, proxyActive, type CameraConfig } from '../cameraRegistry';
import { proxyGroupKey } from './groupKey';

// The cams cameras that share one cam-proxy (cam-proxy spec 2026-10-05
// §12.1, §12.4): one client, one event stream and one Archive entry per
// group. Built from the registry, so it changes only with setCameras().

export interface ProxyGroup {
  key: string; // proxyGroupKey: holds the token, never logged
  url: string;
  token: string;
  members: string[]; // every cams camera on this proxy, config order, switched on or off
  remoteOf: ReadonlyMap<string, string>; // cams id → the proxy's id for it
  pins: string[] | null; // the site CA's fingerprints (spec §12.1); null: no site CA
  tlsServername: string | null; // the name on the proxy's certificate
}

let built: { from: readonly CameraConfig[]; groups: ProxyGroup[] } | undefined;

export function proxyGroups(): ProxyGroup[] {
  const cams = allCameras();
  if (built?.from === cams) return built.groups;
  const byKey = new Map<string, ProxyGroup & { remoteOf: Map<string, string> }>();
  for (const c of cams) {
    if (!c.proxy) continue;
    const key = proxyGroupKey(c.proxy);
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { key, url: c.proxy.url.replace(/\/+$/, ''), token: c.proxy.token, members: [], remoteOf: new Map(), pins: c.proxy.caFingerprint ?? null, tlsServername: c.proxy.tlsServername ?? null }));
    g.members.push(c.id);
    g.remoteOf.set(c.id, c.proxy.camera ?? c.id);
  }
  built = { from: cams, groups: [...byKey.values()] };
  return built.groups;
}

export const groupOf = (id: string): ProxyGroup | undefined => proxyGroups().find((g) => g.members.includes(id));

// The members whose proxy is switched on (Settings), config order.
export const activeMembers = (g: ProxyGroup): string[] => g.members.filter((id) => proxyActive(id));

// The proxy's ids for these members, sorted and unique: the stream's ?cam=.
export const remoteIds = (g: ProxyGroup, members: string[] = activeMembers(g)): string[] => [...new Set(members.map((id) => g.remoteOf.get(id)!))].sort();
