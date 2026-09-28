import { proxyActive } from '../cameraRegistry';
import { getProxyClient, proxyCameraId } from '../proxy/client';
import { logger } from '../logger';
import { getRecordings } from './service';

// How far back a camera's content goes, for the History strip's left edge
// (Klaus, 2026-09-28): the oldest recording on its SD card (the first event of
// the oldest day with recordings, looking back four months) or the oldest
// clip, still or preview at its cam-proxy, whichever is older. Cached for a
// minute; a side that fails counts as having nothing.
const TTL_MS = 60_000;
const MONTHS_BACK = 4;
const cache = new Map<string, { at: number; oldest: number | null }>();

export function resetExtentCache(): void {
  cache.clear();
}

function monthsBack(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

async function cameraOldest(cameraId: string): Promise<number | null> {
  const rec = getRecordings();
  for (const month of monthsBack(MONTHS_BACK)) {
    const days = await rec.days(cameraId, month);
    for (const day of [...days].sort()) {
      const events = await rec.events(cameraId, day);
      if (events.length) return Math.min(...events.map((e) => Date.parse(e.start)));
    }
  }
  return null;
}

async function proxyOldest(cameraId: string): Promise<number | null> {
  if (!proxyActive(cameraId)) return null;
  const client = getProxyClient(cameraId);
  if (!client) return null;
  const e = await client.json<{ clips: number | null; stills: number | null; previews: number | null }>(`/api/cameras/${encodeURIComponent(proxyCameraId(cameraId))}/extent`);
  const all = [e.clips, e.stills, e.previews].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return all.length ? Math.min(...all) : null;
}

export async function extent(cameraId: string): Promise<{ oldest: number | null }> {
  const hit = cache.get(cameraId);
  if (hit && Date.now() - hit.at < TTL_MS) return { oldest: hit.oldest };
  const settle = (p: Promise<number | null>, side: string) =>
    p.catch((err: unknown) => {
      logger.warn({ cameraId, side, message: (err as Error).message }, 'extent_side_failed');
      return null;
    });
  const [cam, proxy] = await Promise.all([settle(cameraOldest(cameraId), 'camera'), settle(proxyOldest(cameraId), 'proxy')]);
  const all = [cam, proxy].filter((v): v is number => v !== null);
  const oldest = all.length ? Math.min(...all) : null;
  cache.set(cameraId, { at: Date.now(), oldest });
  return { oldest };
}
