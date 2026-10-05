import { groupOf } from './groups';
import { ProxyError, proxyCameraId, proxyClientFor, type ProxyClient } from './client';

// The proxy's camera list (GET /api/cameras: every camera it serves, with
// its name, address, web address and, with a site CA, its TLS state). One
// request per proxy at a time: requests within FRESH_MS share one answer, so
// four cameras coming up together ask once (cam-proxy spec 2026-10-05 §12.2).

export interface ProxyCameraEntry { id?: unknown; name?: unknown; address?: unknown; publicUrl?: unknown; tls?: unknown; error?: unknown; features?: unknown }

const FRESH_MS = 2000;
// Per client: resetProxyClients() starts every proxy afresh.
const recent = new WeakMap<ProxyClient, { at: number; done: boolean; list: Promise<ProxyCameraEntry[]> }>();

// Asked even while the camera's proxy is switched off (the Settings page).
// `maxAgeMs`: how old a finished answer may be; 0 shares only a request
// still under way (a person's click wants the proxy's state now).
export function readProxyList(id: string, timeoutMs: number, o: { maxAgeMs?: number } = {}): Promise<ProxyCameraEntry[]> {
  const client = groupOf(id) && proxyClientFor(id);
  if (!client) return Promise.reject(new ProxyError('proxy_unreachable', 'the camera has no cam-proxy'));
  const hit = recent.get(client);
  if (hit && (!hit.done || Date.now() - hit.at < (o.maxAgeMs ?? FRESH_MS))) return hit.list;
  const list = client.json<unknown>('/api/cameras', undefined, { timeoutMs }).then((l) => (Array.isArray(l) ? (l as ProxyCameraEntry[]) : []));
  const entry = { at: Date.now(), done: false, list };
  recent.set(client, entry);
  list.then(
    () => {
      entry.done = true;
    },
    () => {
      if (recent.get(client) === entry) recent.delete(client); // a failure isn't shared with later callers
    },
  );
  return list;
}

// Whether the proxy takes ?cam=a,b: "sse-cam-list" in its items' features
// (cam-proxy P1; spec §6.1, §6.2). A proxy from before that reads the list
// as one id and would send nothing. A failed read counts as "no": the
// stream then asks for every camera and fans out by `cam` itself.
export async function supportsCamList(id: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const list = await readProxyList(id, timeoutMs);
    return list.some((c) => Array.isArray(c?.features) && c.features.includes('sse-cam-list'));
  } catch {
    return false;
  }
}

// This cams camera's entry (by the proxy's id for it).
export function entryOf(id: string, list: ProxyCameraEntry[]): ProxyCameraEntry | undefined {
  const remote = proxyCameraId(id);
  return list.find((c) => c?.id === remote);
}
