import type { Dispatcher } from 'undici';
import type { ProxyGroup } from '../proxy/groups';
import { fetchPinnedCa, siteCaDispatcher } from './siteCa';
import { addVerifiedCa, trustEvents, verifiedCas } from './store';

// A pinned cam-proxy's site CA at run time (cam-proxy spec 2026-10-05
// §10.1.4): cached once verified, fetched again when the proxy's certificate
// stops verifying (a rotation within the pinned list, §10.7).

const inflight = new Map<string, Promise<string[]>>();
const dispatchers = new Map<string, { cas: string; dispatcher: Dispatcher }>();
const refetch = new Set<string>();

export function ensureGroupCa(g: ProxyGroup, o: { force?: boolean } = {}): Promise<string[]> {
  const pins = g.pins;
  if (!pins) return Promise.resolve([]);
  const cached = verifiedCas(pins);
  if (cached.length && !o.force) return Promise.resolve(cached);
  let p = inflight.get(g.key);
  if (!p) {
    p = fetchPinnedCa(g.url, pins)
      .then(async (ca) => {
        const before = verifiedCas(pins).join('');
        await addVerifiedCa(ca.fingerprint, ca.pem);
        const now = verifiedCas(pins);
        if (now.join('') !== before) for (const cam of g.members) trustEvents.emit('trust', { cam });
        return now;
      })
      .finally(() => inflight.delete(g.key));
    inflight.set(g.key, p);
  }
  return p;
}

// The dispatcher for an https proxy with a pinned site CA; undefined for any
// other proxy (global fetch, as before). Rejects like fetchPinnedCa.
export async function groupDispatcher(g: ProxyGroup): Promise<Dispatcher | undefined> {
  if (!g.pins || !g.url.startsWith('https:')) return undefined;
  const force = refetch.delete(g.key);
  const cas = await ensureGroupCa(g, { force });
  const key = cas.join('');
  const hit = dispatchers.get(g.key);
  if (hit?.cas === key) return hit.dispatcher;
  void hit?.dispatcher.close().catch(() => undefined);
  const dispatcher = siteCaDispatcher(cas, g.tlsServername ?? undefined);
  dispatchers.set(g.key, { cas: key, dispatcher });
  return dispatcher;
}

// The proxy's certificate failed to verify: ask for its CA again next time.
export function groupTlsFailed(g: ProxyGroup): void {
  refetch.add(g.key);
}
