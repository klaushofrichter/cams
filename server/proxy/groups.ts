import { allCameras, proxyActive, type CameraConfig } from '../cameraRegistry';
import type { CamKey } from '../fleet';
import { proxyGroupKey } from './groupKey';

// The cams cameras that share one cam-proxy (cam-proxy spec 2026-10-05
// §12.1, §12.4): one client, one event stream and one Archive entry per
// group. Built from the registry, so it changes only with setCameras().

export interface ProxyGroup {
  key: string; // proxyGroupKey: holds the token, never logged
  accountId: string;
  url: string;
  token: string;
  members: CamKey[]; // every cams camera on this proxy, config order, switched on or off
  remoteOf: ReadonlyMap<CamKey, string>; // cams key → the proxy's id for it
  pins: string[] | null; // the site CA's fingerprints (spec §12.1); null: no site CA
  tlsServername: string | null; // the name on the proxy's certificate
}

let built: { from: readonly CameraConfig[]; groups: ProxyGroup[] } | undefined;

export function proxyGroups(): ProxyGroup[] {
  const cams = allCameras();
  if (built?.from === cams) return built.groups;
  const byKey = new Map<string, ProxyGroup & { remoteOf: Map<CamKey, string> }>();
  for (const c of cams) {
    if (!c.proxy) continue;
    const key = proxyGroupKey(c.accountId, c.proxy);
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { key, accountId: c.accountId, url: c.proxy.url.replace(/\/+$/, ''), token: c.proxy.token, members: [], remoteOf: new Map(), pins: c.proxy.caFingerprint ?? null, tlsServername: c.proxy.tlsServername ?? null }));
    g.members.push(c.id);
    g.remoteOf.set(c.id, c.proxy.camera ?? c.camsId);
  }
  built = { from: cams, groups: [...byKey.values()] };
  return built.groups;
}

export const groupOf = (id: CamKey): ProxyGroup | undefined => proxyGroups().find((g) => g.members.includes(id));

// The members whose proxy is switched on (Settings), config order.
export const activeMembers = (g: ProxyGroup): CamKey[] => g.members.filter((id) => proxyActive(id));

// The proxy's ids for these members, sorted and unique: the stream's ?cam=.
export const remoteIds = (g: ProxyGroup, members: CamKey[] = activeMembers(g)): string[] => [...new Set(members.map((id) => g.remoteOf.get(id)!))].sort();
