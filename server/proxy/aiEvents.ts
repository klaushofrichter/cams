import { logger } from '../logger';
import { parseProxyEvents, type ProxyEvent } from '../recordings/detection';
import { CATEGORIES, dayWindow } from './analyses';
import { getProxyClient, proxyPath, ProxyError } from './client';
import { proxyHub } from './stream';

// cam-proxy's person, vehicle and pet events of a camera's day, for the
// cards' per-type counts ("Person 2x", Klaus 2026-10-04) and their
// thumbnails' version. One request per AI type (GET /events?kind=…): a busy
// day has more motion events than one answer holds. A camera event or an
// analysis for the camera drops its cached days, so the reload it causes
// (pages reload the day on those messages) sees it.

const RECENT_TTL = 60_000;
const PAST_TTL = 3_600_000;
const FETCH_TIMEOUT_MS = 3000;
const FAIL_TTL = 30_000; // after a failed fetch, the proxy is not asked again for this long
const LIMIT = 1000;

export class AiEventStore {
  private days = new Map<string, { at: number; list: ProxyEvent[] }>(); // `${cam}|${date}`
  private inflight = new Map<string, Promise<ProxyEvent[] | null>>();
  private failed = new Map<string, number>();
  private gen = new Map<string, number>(); // per camera: bumped by invalidate()

  // The day's AI events, oldest first; null when the proxy can't tell (an
  // error, or a camera without one).
  async forDay(cam: string, date: string, cards: { start: string }[], now = Date.now()): Promise<ProxyEvent[] | null> {
    if (!cards.length) return [];
    const win = dayWindow(date, cards[0].start);
    if (!win) return null;
    const key = `${cam}|${date}`;
    for (const [k, d] of this.days) if (now - d.at >= PAST_TTL) this.days.delete(k);
    for (const [k, at] of this.failed) if (now - at >= FAIL_TTL) this.failed.delete(k);
    const hit = this.days.get(key);
    const ttl = (hit?.at ?? now) <= win[1] ? RECENT_TTL : PAST_TTL;
    if (hit && now - hit.at < ttl) return hit.list;
    if (this.failed.has(key)) return null;
    return this.inflight.get(key) ?? this.fetch(cam, key, win, now);
  }

  invalidate(cam: string): void {
    this.gen.set(cam, (this.gen.get(cam) ?? 0) + 1);
    for (const k of this.days.keys()) if (k.startsWith(`${cam}|`)) this.days.delete(k);
    for (const k of this.inflight.keys()) if (k.startsWith(`${cam}|`)) this.inflight.delete(k);
  }

  private fetch(cam: string, key: string, win: [number, number], now: number): Promise<ProxyEvent[] | null> {
    const gen = this.gen.get(cam) ?? 0;
    const work = (async () => {
      const client = getProxyClient(cam);
      if (!client) return null;
      try {
        const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const lists = await Promise.all(
          CATEGORIES.map((kind) => client.json<unknown>(proxyPath(cam, '/events'), { from: win[0], to: win[1], kind, limit: LIMIT }, { timeoutMs: FETCH_TIMEOUT_MS, signal })),
        );
        const list = lists.flatMap(parseProxyEvents).sort((a, b) => a.start - b.start || a.id - b.id);
        // A day fetched before an invalidation may miss what caused it: not kept.
        if ((this.gen.get(cam) ?? 0) === gen) this.days.set(key, { at: now, list });
        this.failed.delete(key);
        return list;
      } catch (err) {
        logger.debug({ cameraId: cam, code: err instanceof ProxyError ? err.code : 'error' }, 'proxy_ai_events_unavailable');
        this.failed.set(key, Date.now());
        return null;
      }
    })().finally(() => {
      if (this.inflight.get(key) === work) this.inflight.delete(key);
    });
    this.inflight.set(key, work);
    return work;
  }
}

let store = new AiEventStore();
export const getAiEventStore = (): AiEventStore => store;
export function resetAiEventStore(): void {
  store = new AiEventStore();
}

// A camera's new event or analysis: its days are read again.
proxyHub.on('message', (m: { cam: string; type: string }) => {
  if (m.type === 'camera-event' || m.type === 'analysis' || m.type === 'reset') store.invalidate(m.cam);
});
