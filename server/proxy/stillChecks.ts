import { logger } from '../logger';
import { parseObjects, parseSummary, type StillObject, type SummaryEntry } from './analyses';
import { getProxyClient, proxyPath, ProxyError } from './client';
import { proxyHub } from './stream';
import { DayCache } from './dayCache';
import type { CamKey } from '../fleet';

// cam-proxy's still checks (cams #179, cam-proxy's still checks API): Vision
// on a second picked by hand. Not events: kept in their own list, shown on
// the Timeline, and confirming a card's labels (spec
// 2026-10-04-still-checks-ui-design).

export interface LinkedEvent { id: number; kind: string; confirmed: boolean }
export interface StillCheck {
  id: number | null; // null: an automatic analysis answered (source "event")
  eventId: number | null;
  stillTs: number;
  provider: string;
  summary: SummaryEntry[];
  events: LinkedEvent[];
  image: boolean; // the proxy kept its JPEG
}
export interface FullCheck extends StillCheck { objects: StillObject[]; requestedAt: number | null; tookMs: number | null }

export interface Usage {
  enabled: boolean;
  paused: { reason: string; until: number | null } | null;
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  checks: { today: number; cap: number };
}

const int = (v: unknown): v is number => Number.isSafeInteger(v);
const count = (v: unknown): number => (int(v) && v >= 0 ? v : 0);

function parseEvents(v: unknown): LinkedEvent[] {
  return (Array.isArray(v) ? v : []).flatMap((x) => {
    const e = x as { id?: unknown; kind?: unknown; confirmed?: unknown } | null;
    if (!e || !int(e.id) || typeof e.kind !== 'string' || !/^[a-z_-]{1,32}$/.test(e.kind)) return [];
    return [{ id: e.id, kind: e.kind, confirmed: e.confirmed === true }];
  });
}

// One check from the proxy, or null. The image is only "there or not": cams
// builds its own URL from the id (never the proxy's).
export function parseCheck(v: unknown): StillCheck | null {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || !int(c.stillTs) || (c.id !== null && !int(c.id))) return null;
  return {
    id: c.id as number | null,
    eventId: int(c.eventId) ? c.eventId : null,
    stillTs: c.stillTs,
    provider: typeof c.provider === 'string' ? c.provider.slice(0, 64) : 'unknown',
    summary: parseSummary(c.summary),
    events: parseEvents(c.events),
    image: c.id !== null && typeof c.imageUrl === 'string',
  };
}

export function parseFullCheck(v: unknown): FullCheck | null {
  const c = parseCheck(v);
  if (!c) return null;
  const x = v as Record<string, unknown>;
  return { ...c, objects: parseObjects(x.objects), requestedAt: int(x.requestedAt) ? x.requestedAt : null, tookMs: int(x.tookMs) ? x.tookMs : null };
}

export function parseUsage(v: unknown): Usage {
  const u = (v ?? {}) as Record<string, Record<string, unknown> | null | undefined | boolean>;
  const part = (k: string) => (u[k] && typeof u[k] === 'object' ? (u[k] as Record<string, unknown>) : {});
  const p = u.paused && typeof u.paused === 'object' ? (u.paused as Record<string, unknown>) : null;
  return {
    enabled: u.enabled === true,
    paused: p && typeof p.reason === 'string' ? { reason: p.reason.slice(0, 32), until: int(p.until) ? p.until : null } : null,
    month: { calls: count(part('month').calls), limit: count(part('month').limit) },
    today: { calls: count(part('today').calls), cap: count(part('today').cap) },
    checks: { today: count(part('checks').today), cap: count(part('checks').cap) },
  };
}

const FETCH_TIMEOUT_MS = 3000;

// The checks of a camera's day, for the cards (GET /events), cached like the
// AI events (DayCache); a `still-check` message drops the camera's days.
// While the proxy fails: the day as last fetched, else none. An older proxy
// has no checks (404): an empty day, kept like one.
class CheckStore {
  private cache = new DayCache<StillCheck>({
    async fetch(cam, win) {
      const client = getProxyClient(cam);
      if (!client) return null;
      const body = await client.json<unknown>(proxyPath(cam, '/still-checks'), { from: win[0], to: win[1] }, { timeoutMs: FETCH_TIMEOUT_MS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      return (Array.isArray(body) ? body : []).map(parseCheck).filter((c): c is StillCheck => c !== null);
    },
    failure(cam, err) {
      const status = err instanceof ProxyError ? err.status : undefined;
      logger.debug({ cameraId: cam, code: err instanceof ProxyError ? err.code : 'error', status }, 'proxy_still_checks_unavailable');
      return status === 404 ? 'empty' : 'failed';
    },
  });

  async forDay(cam: CamKey, date: string, cards: { start: string }[], now = Date.now()): Promise<StillCheck[]> {
    return (await this.cache.forDay(cam, date, cards, now)) ?? this.cache.last(cam, date) ?? [];
  }

  invalidate(cam: CamKey): void {
    this.cache.invalidate(cam);
  }
}

let store = new CheckStore();
export const getCheckStore = (): CheckStore => store;
export function resetCheckStore(): void {
  store = new CheckStore();
}

// A new check: the camera's days are fetched again (its cards may be confirmed).
proxyHub.on('message', (m: { cam: CamKey; type: string }) => {
  if (m.type === 'still-check' || m.type === 'reset') store.invalidate(m.cam);
});
