import type { CamKey } from '../fleet';
import { dayWindow } from './analyses';

// A camera's day of one proxy list (the AI events, the still checks), cached
// for the cards (GET /events): a day fetched while it still went on is kept a
// minute, a past one an hour; a failed fetch isn't repeated for 30 s;
// callers at once share one fetch; invalidate(cam) drops the camera's days,
// and a fetch that started before it isn't kept (it may miss the cause).
const RECENT_TTL = 60_000;
const PAST_TTL = 3_600_000;
const FAIL_TTL = 30_000;

export interface DayCacheSource<T> {
  // The day's list from the proxy; null when the camera has no proxy client
  // (nothing kept, nothing failed). Throws when the proxy can't answer.
  fetch(cam: CamKey, win: [number, number]): Promise<T[] | null>;
  // A failed fetch, logged by the store: 'empty' keeps it as an empty day
  // (an older proxy without the route), 'failed' starts the 30 s pause.
  failure(cam: CamKey, err: unknown): 'empty' | 'failed';
}

export class DayCache<T> {
  private days = new Map<string, { at: number; list: T[] }>(); // `${cam}|${date}`
  private inflight = new Map<string, Promise<T[] | null>>();
  private failed = new Map<string, number>();
  private gen = new Map<string, number>(); // per camera: bumped by invalidate()

  constructor(private readonly source: DayCacheSource<T>) {}

  // The day's list; null when it can't be told (no window from the cards, no
  // proxy client, a failed fetch, or the pause after one).
  async forDay(cam: CamKey, date: string, cards: { start: string }[], now = Date.now()): Promise<T[] | null> {
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

  // The day as last fetched, even past its time to live (still within the hour).
  last(cam: CamKey, date: string): T[] | undefined {
    return this.days.get(`${cam}|${date}`)?.list;
  }

  invalidate(cam: CamKey): void {
    this.gen.set(cam, (this.gen.get(cam) ?? 0) + 1);
    for (const k of this.days.keys()) if (k.startsWith(`${cam}|`)) this.days.delete(k);
    for (const k of this.inflight.keys()) if (k.startsWith(`${cam}|`)) this.inflight.delete(k);
  }

  private fetch(cam: CamKey, key: string, win: [number, number], now: number): Promise<T[] | null> {
    const gen = this.gen.get(cam) ?? 0;
    const keep = (list: T[]) => {
      if ((this.gen.get(cam) ?? 0) === gen) this.days.set(key, { at: now, list });
    };
    const work = (async () => {
      try {
        const list = await this.source.fetch(cam, win);
        if (list === null) return null;
        keep(list);
        this.failed.delete(key);
        return list;
      } catch (err) {
        if (this.source.failure(cam, err) === 'empty') {
          keep([]);
          return [];
        }
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
