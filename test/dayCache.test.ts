import { describe, expect, it, vi } from 'vitest';
import { DayCache } from '../server/proxy/dayCache';
import type { CamKey } from '../server/fleet';

const CAM = 'acc/den' as CamKey;
const DATE = '2026-10-01';
const DAY_START = Date.parse('2026-10-01T00:00:00Z');
const cards = [{ start: '2026-10-01T08:00:00.000Z' }];
const AFTER_DAY = DAY_START + 86_400_000; // the window has ended
const IN_DAY = DAY_START + 12 * 3_600_000; // the day still goes on

function cache(o: { fetch?: () => Promise<number[] | null>; failure?: () => 'empty' | 'failed' } = {}) {
  const fetch = vi.fn(o.fetch ?? (async () => [1, 2]));
  const failure = vi.fn(o.failure ?? (() => 'failed' as const));
  return { c: new DayCache<number>({ fetch, failure }), fetch, failure };
}

describe('DayCache', () => {
  it('keeps a past day an hour and a running day a minute', async () => {
    const past = cache();
    expect(await past.c.forDay(CAM, DATE, cards, AFTER_DAY)).toEqual([1, 2]);
    await past.c.forDay(CAM, DATE, cards, AFTER_DAY + 3_599_000);
    expect(past.fetch).toHaveBeenCalledTimes(1);
    await past.c.forDay(CAM, DATE, cards, AFTER_DAY + 3_600_000);
    expect(past.fetch).toHaveBeenCalledTimes(2);

    const running = cache();
    await running.c.forDay(CAM, DATE, cards, IN_DAY);
    await running.c.forDay(CAM, DATE, cards, IN_DAY + 59_000);
    expect(running.fetch).toHaveBeenCalledTimes(1);
    await running.c.forDay(CAM, DATE, cards, IN_DAY + 60_000);
    expect(running.fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between callers at once', async () => {
    const { c, fetch } = cache();
    const [a, b] = await Promise.all([c.forDay(CAM, DATE, cards, AFTER_DAY), c.forDay(CAM, DATE, cards, AFTER_DAY)]);
    expect(a).toEqual([1, 2]);
    expect(b).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('after a failure answers null without asking again for 30 s, and keeps the last day for last()', async () => {
    vi.useFakeTimers({ now: AFTER_DAY + 3_600_000 });
    try {
      let fail = false;
      const { c, fetch } = cache({ fetch: async () => (fail ? Promise.reject(new Error('down')) : [7]) });
      expect(await c.forDay(CAM, DATE, cards, IN_DAY)).toEqual([7]);
      fail = true;
      expect(await c.forDay(CAM, DATE, cards, IN_DAY + 60_000)).toBeNull();
      expect(c.last(CAM, DATE)).toEqual([7]);
      expect(await c.forDay(CAM, DATE, cards, IN_DAY + 61_000)).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(30_000);
      fail = false;
      expect(await c.forDay(CAM, DATE, cards, Date.now())).toEqual([7]);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a failure the source calls 'empty' as an empty day", async () => {
    const { c, fetch } = cache({ fetch: async () => Promise.reject(new Error('404')), failure: () => 'empty' });
    expect(await c.forDay(CAM, DATE, cards, AFTER_DAY)).toEqual([]);
    expect(await c.forDay(CAM, DATE, cards, AFTER_DAY + 1000)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not keep a day whose fetch started before an invalidation', async () => {
    let release!: (v: number[]) => void;
    const { c, fetch } = cache({ fetch: () => new Promise<number[]>((r) => (release = r)) });
    const first = c.forDay(CAM, DATE, cards, AFTER_DAY);
    c.invalidate(CAM);
    release([1]);
    expect(await first).toEqual([1]);
    expect(c.last(CAM, DATE)).toBeUndefined();
    void c.forDay(CAM, DATE, cards, AFTER_DAY);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('answers null without a proxy client, keeping nothing', async () => {
    const { c } = cache({ fetch: async () => null });
    expect(await c.forDay(CAM, DATE, cards, AFTER_DAY)).toBeNull();
    expect(c.last(CAM, DATE)).toBeUndefined();
    expect(await c.forDay(CAM, DATE, [], AFTER_DAY)).toEqual([]);
  });
});
