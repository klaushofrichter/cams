// web/src/lib/stripData.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createStripData } from './stripData';
import { resetDayCache, type Fetch } from './dayCache';

// TZ=America/Chicago. 2026-09-27 12:00 CDT.
const NOON = Date.parse('2026-09-27T12:00:00-05:00');
const ev = { id: '20260927-120000-120030', start: '2026-09-27T17:00:00.000Z', end: '2026-09-27T17:00:30.000Z', durationSec: 30, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetDayCache());

function fakeFetch(fail: RegExp | null = null) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    urls.push(url);
    if (fail && fail.test(url)) throw new Error('502');
    if (url.includes('/events?date=2026-09-27')) return { events: [ev], downloads: 'ok' };
    if (url.includes('/events?')) return { events: [], downloads: 'ok' };
    if (url.includes('/previews?')) return [];
    if (url.includes('/stills?')) return [NOON, NOON + 1000, NOON + 2000];
    throw new Error(`unexpected ${url}`);
  });
  return { fn: fn as unknown as Fetch, urls };
}

describe('createStripData', () => {
  it('loads the days a window touches plus one either side, once', async () => {
    const { fn, urls } = fakeFetch();
    const d = createStripData('den', true, fn);
    d.ensure(NOON - 3_600_000, NOON + 3_600_000);
    d.ensure(NOON - 60_000, NOON + 60_000); // same days: no new requests
    await flush();
    expect(urls.filter((u) => u.includes('/events?')).map((u) => u.split('date=')[1]).sort()).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    expect(get(d.coverage).clips.map((c) => c.clip.id)).toEqual([ev.id]);
    expect(d.eventsOn('2026-09-27')).toEqual([ev]);
    expect(d.eventsOn('2026-09-20')).toBeNull();
  });

  it('a second instance for the same camera sees days already cached', async () => {
    const { fn } = fakeFetch();
    const first = createStripData('den', false, fn);
    first.ensure(NOON, NOON);
    await flush();
    first.destroy();
    const again = createStripData('den', false, fn);
    let latest: string[] = [];
    const stop = again.coverage.subscribe((c) => (latest = c.clips.map((x) => x.clip.id))); // subscribed first, as HistoryView does
    again.ensure(NOON, NOON);
    await flush();
    expect(latest).toEqual([ev.id]);
    stop();
  });

  it('loads stills by the hour and turns them into runs', async () => {
    const { fn, urls } = fakeFetch();
    const d = createStripData('den', true, fn);
    d.ensureStills(NOON + 10_000);
    d.ensureStills(NOON + 20_000);
    await flush();
    expect(urls.filter((u) => u.includes('/stills?'))).toHaveLength(2); // this hour and the next
    expect(get(d.coverage).stills).toEqual([{ start: NOON, end: NOON + 3000 }]);
  });

  it('asks nothing of a proxy the camera does not have', async () => {
    const { fn, urls } = fakeFetch();
    const d = createStripData('shed', false, fn);
    d.ensure(NOON, NOON);
    d.ensureStills(NOON);
    await flush();
    expect(urls.some((u) => u.includes('/stills?') || u.includes('/previews?'))).toBe(false);
  });

  it('treats a failed stills hour as empty and tries it again after a minute', async () => {
    vi.useFakeTimers();
    try {
      const { fn, urls } = fakeFetch(/\/stills\?/);
      const d = createStripData('den', true, fn);
      d.ensureStills(NOON);
      await vi.advanceTimersByTimeAsync(0);
      d.ensureStills(NOON);
      await vi.advanceTimersByTimeAsync(0);
      expect(urls.filter((u) => u.includes('/stills?'))).toHaveLength(2); // not retried at once
      vi.advanceTimersByTime(61_000);
      d.ensureStills(NOON);
      await vi.advanceTimersByTimeAsync(0);
      expect(urls.filter((u) => u.includes('/stills?'))).toHaveLength(4);
      expect(get(d.coverage).stills).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a failed clip from the coverage', async () => {
    const { fn } = fakeFetch();
    const d = createStripData('den', true, fn);
    d.ensure(NOON, NOON);
    await flush();
    d.markFailed(ev.id);
    expect(get(d.coverage).clips).toEqual([]);
  });
});
