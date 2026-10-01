import { logger } from '../logger';
import { getProxyClient, proxyCameraId, ProxyError } from './client';
import { proxyHub } from './stream';

// cam-proxy's Vision results (spec 2026-09-30-analytics-in-cams-design, in
// cam-proxy): the summary only, per camera. Live ones arrive with the
// `analysis` stream message; a day load fetches the rest.

export type Category = 'person' | 'vehicle' | 'pet';
export const CATEGORIES: Category[] = ['person', 'vehicle', 'pet'];
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface SummaryEntry { category: Category; subtype: string; score: number; box: Box }
export interface StillObject { name: string; score: number; box: Box | null }
export interface ProxyAnalysis {
  eventId: number;
  kind: string;
  start: number;
  end: number | null;
  status: string;
  reason: string | null;
  stillTs: number | null;
  summary: SummaryEntry[];
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unit = (v: unknown): v is number => num(v) && v >= 0 && v <= 1;
const int = (v: unknown): v is number => Number.isSafeInteger(v);

function parseBox(v: unknown): Box | null {
  const b = v as Partial<Box> | null | undefined;
  return b && unit(b.x0) && unit(b.y0) && unit(b.x1) && unit(b.y1) ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null;
}

export function parseSummary(v: unknown): SummaryEntry[] {
  return (Array.isArray(v) ? v : []).flatMap((x) => {
    const e = x as { category?: unknown; subtype?: unknown; score?: unknown; box?: unknown } | null;
    const box = parseBox(e?.box);
    if (!e || !CATEGORIES.includes(e.category as Category) || typeof e.subtype !== 'string' || !unit(e.score) || !box) return [];
    return [{ category: e.category as Category, subtype: e.subtype.slice(0, 64), score: e.score, box }];
  });
}

export function parseObjects(v: unknown): StillObject[] {
  return (Array.isArray(v) ? v : []).flatMap((x) => {
    const o = x as { name?: unknown; score?: unknown; box?: unknown } | null;
    if (!o || typeof o.name !== 'string' || !unit(o.score)) return [];
    return [{ name: o.name.slice(0, 64), score: o.score, box: parseBox(o.box) }];
  });
}

// One analysis from the proxy, or null for anything else (an older proxy's
// message has no start or summary).
export function parseAnalysis(v: unknown): ProxyAnalysis | null {
  const a = v as Record<string, unknown> | null;
  if (!a || !int(a.eventId) || typeof a.kind !== 'string' || !int(a.start) || typeof a.status !== 'string' || !Array.isArray(a.summary)) return null;
  return {
    eventId: a.eventId,
    kind: a.kind,
    start: a.start,
    end: int(a.end) ? a.end : null,
    status: a.status,
    reason: typeof a.reason === 'string' ? a.reason : null,
    stillTs: int(a.stillTs) ? a.stillTs : null,
    summary: parseSummary(a.summary),
  };
}

const DAY = 86_400_000;
export const SLACK_MS = 5000; // an analysis counts for a card from 5 s before it
const RECENT_TTL = 60_000;
const PAST_TTL = 3_600_000;
const LIVE_KEEP_MS = 2 * DAY;
const FETCH_TIMEOUT_MS = 3000;
const FAIL_TTL = 30_000; // after a failed fetch, the proxy is not asked again for this long

// The camera's day as [first ms, last ms], from a card's time and its offset:
// 5 s early for the slack, and one day long, the proxy's limit (a 25-hour
// day loses its last hour, a day's last 5 s go to the next day's window).
export function dayWindow(date: string, sampleIso: string): [number, number] | null {
  const off = /([+-]\d{2}:\d{2}|Z)$/.exec(sampleIso)?.[1];
  if (!off) return null;
  const start = Date.parse(`${date}T00:00:00${off}`);
  if (!Number.isFinite(start)) return null;
  return [start - SLACK_MS, start - SLACK_MS + DAY - 1];
}

export class AnalysisStore {
  private live = new Map<string, Map<number, { a: ProxyAnalysis; at: number }>>(); // cam → eventId → received, and when
  private days = new Map<string, { at: number; list: ProxyAnalysis[] }>(); // `${cam}|${date}`
  private inflight = new Map<string, Promise<{ at: number; list: ProxyAnalysis[] }>>();
  private failed = new Map<string, number>(); // `${cam}|${date}` → when the fetch failed

  constructor(private readonly o: { timeoutMs?: number } = {}) {}

  ingest(cam: string, a: ProxyAnalysis, now = Date.now()): void {
    let m = this.live.get(cam);
    if (!m) this.live.set(cam, (m = new Map()));
    m.set(a.eventId, { a, at: now });
    for (const [id, x] of m) if (x.a.start < now - LIVE_KEEP_MS) m.delete(id);
  }

  // The analyses for a camera's day of cards, oldest first: the fetched day
  // (cached), with received messages over it. Never throws: while the proxy
  // fails, the received ones only.
  async forDay(cam: string, date: string, events: { start: string; end: string }[], now = Date.now()): Promise<ProxyAnalysis[]> {
    if (!events.length) return [];
    const win = dayWindow(date, events[0].start);
    if (!win) return [];
    for (const [k, d] of this.days) if (now - d.at >= PAST_TTL) this.days.delete(k);
    for (const [k, at] of this.failed) if (now - at >= FAIL_TTL) this.failed.delete(k);
    const key = `${cam}|${date}`;
    const hit = this.days.get(key);
    // A day fetched while it was still going on is "today" until fetched
    // again after its end: its last minutes' analyses may have been missing.
    const ttl = (hit?.at ?? now) <= win[1] ? RECENT_TTL : PAST_TTL;
    let day: { at: number; list: ProxyAnalysis[] };
    // While the proxy fails, an expired day is served as it was.
    if (hit && (now - hit.at < ttl || this.failed.has(key))) day = hit;
    else if (this.failed.has(key)) day = { at: -Infinity, list: [] };
    else day = await (this.inflight.get(key) ?? this.fetch(cam, key, win, now));
    // A received message wins over the fetched record unless the record was
    // fetched after it arrived (a later fetch knows the event's end).
    const byId = new Map(day.list.map((a) => [a.eventId, a]));
    for (const { a, at } of this.live.get(cam)?.values() ?? []) {
      if (a.start >= win[0] && a.start <= win[1] && (at >= day.at || !byId.has(a.eventId))) byId.set(a.eventId, a);
    }
    return [...byId.values()].sort((a, b) => a.start - b.start || a.eventId - b.eventId);
  }

  private fetch(cam: string, key: string, win: [number, number], now: number): Promise<{ at: number; list: ProxyAnalysis[] }> {
    const work = (async () => {
      const stale = this.days.get(key) ?? { at: -Infinity, list: [] };
      const client = getProxyClient(cam);
      if (!client) return stale;
      const t0 = Date.now();
      try {
        // The whole fetch, body included, is bound by one timer: the events
        // page waits for this.
        const ms = this.o.timeoutMs ?? FETCH_TIMEOUT_MS;
        const body = await client.json<unknown>(`/api/cameras/${encodeURIComponent(proxyCameraId(cam))}/analyses`, { from: win[0], to: win[1] }, { timeoutMs: ms, signal: AbortSignal.timeout(ms) });
        const list = (Array.isArray(body) ? body : []).map(parseAnalysis).filter((a): a is ProxyAnalysis => a !== null);
        const day = { at: now, list };
        this.days.set(key, day);
        this.failed.delete(key);
        return day;
      } catch (err) {
        // An older proxy has no /analyses (404): no badges, remembered like an empty day.
        const status = err instanceof ProxyError ? err.status : undefined;
        logger.debug({ cameraId: cam, code: err instanceof ProxyError ? err.code : 'error', status }, 'proxy_analyses_unavailable');
        if (status === 404) {
          const day = { at: now, list: [] };
          this.days.set(key, day);
          return day;
        }
        // Remembered from when it failed, not from when it was asked: a
        // timeout doesn't shorten the 30 s.
        this.failed.set(key, now + (Date.now() - t0));
        return stale;
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }
}

let store = new AnalysisStore();
export const getAnalysisStore = (): AnalysisStore => store;
export function resetAnalysisStore(o: { timeoutMs?: number } = {}): void {
  store = new AnalysisStore(o);
}

// Every camera's `analysis` messages, as they arrive.
proxyHub.on('message', (m: { cam: string; type: string; data: unknown }) => {
  if (m.type !== 'analysis') return;
  const a = parseAnalysis(m.data);
  if (a) store.ingest(m.cam, a);
});
