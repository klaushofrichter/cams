// web/src/lib/dayCache.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { affectedDays, dayStore, followDayChanges, loadDay, onDayInvalidated, resetDayCache, sourceLabel, type Fetch } from './dayCache';
import type { Change } from './eventStream';

const asFetch = (m: unknown) => m as Fetch;

beforeEach(() => resetDayCache());

describe('dayCache', () => {
  it('asks once per camera and day, also for requests in flight', async () => {
    const fetch = vi.fn(async () => ({ events: [], downloads: 'ok' }));
    await Promise.all([loadDay('den', '2026-09-27', { fetch: asFetch(fetch) }), loadDay('den', '2026-09-27', { fetch: asFetch(fetch) })]);
    await loadDay('den', '2026-09-27', { fetch: asFetch(fetch) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(get(dayStore).get('den|2026-09-27')).toEqual({ events: [], downloads: 'ok' });
  });

  it('asks again when forced (a refresh of today)', async () => {
    const fetch = vi.fn(async () => ({ events: [], downloads: 'ok' }));
    await loadDay('den', '2026-09-27', { fetch: asFetch(fetch) });
    await loadDay('den', '2026-09-27', { fetch: asFetch(fetch), force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed request, so the next call tries again', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('502')).mockResolvedValue({ events: [], downloads: 'ok' });
    await expect(loadDay('den', '2026-09-27', { fetch: asFetch(fetch) })).rejects.toThrow('502');
    await loadDay('den', '2026-09-27', { fetch: asFetch(fetch) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('names the source of recordings for the note under the player', () => {
    expect(sourceLabel('proxy-recordings')).toBe('cam-proxy (SD card)');
    expect(sourceLabel('proxy')).toBe('cam-proxy (FTP copies)');
    expect(sourceLabel('ok')).toBe('camera');
  });
});

// A new analysis or still check (cams' `change` relay) changes a day's cards:
// every cached copy of that day is dropped, and pages showing it are told
// (Klaus, 2026-10-04: a check on the Timeline left the Video page's card
// "not confirmed" until a reload).
describe('dayCache after a new analysis or still check', () => {
  const at = (local: string) => new Date(local).getTime(); // TZ America/Chicago (vitest config)
  const day = (events: { start: string; end: string }[] = []) => ({ events, downloads: 'ok' });
  function fakeStream() {
    const fns = new Set<(c: Change) => void>();
    return { onChange: (fn: (c: Change) => void) => (fns.add(fn), () => fns.delete(fn)), fire: (c: Change) => fns.forEach((f) => f(c)) };
  }

  it('makes the day of a still check and of an analysis stale: kept for its readers, asked again', async () => {
    const s = fakeStream();
    const stop = followDayChanges(s);
    const fetch = vi.fn(async () => day());
    await loadDay('den', '2026-10-03', { fetch: asFetch(fetch) });
    s.fire({ cam: 'den', type: 'still-check', ts: at('2026-10-03T21:22:07') });
    // The History strip keeps its recordings meanwhile.
    expect(get(dayStore).has('den|2026-10-03')).toBe(true);
    await loadDay('den', '2026-10-03', { fetch: asFetch(fetch) });
    await loadDay('den', '2026-10-03', { fetch: asFetch(fetch) }); // fresh again: from the cache
    s.fire({ cam: 'den', type: 'analysis', ts: at('2026-10-03T21:21:56') });
    await loadDay('den', '2026-10-03', { fetch: asFetch(fetch) });
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
  });

  it('tells the pages, and leaves other cameras, other days and other messages alone', async () => {
    const s = fakeStream();
    const stop = followDayChanges(s);
    const told: string[] = [];
    const off = onDayInvalidated((cam, d) => told.push(`${cam}|${d}`));
    const fetch = vi.fn(async () => day());
    const all = [['den', '2026-10-02'], ['den', '2026-10-03'], ['yard', '2026-10-03']];
    for (const [c, d] of all) await loadDay(c, d, { fetch: asFetch(fetch) });
    s.fire({ cam: 'den', type: 'clip', ts: at('2026-10-03T12:00:00') });
    s.fire({ cam: 'den', type: 'camera-status', ts: null });
    expect(told).toEqual([]);
    s.fire({ cam: 'den', type: 'still-check', ts: at('2026-10-03T12:00:00') });
    expect(told).toEqual(['den|2026-10-03']);
    fetch.mockClear();
    for (const [c, d] of all) await loadDay(c, d, { fetch: asFetch(fetch) });
    expect(fetch.mock.calls).toEqual([['/api/cameras/den/events?date=2026-10-03']]);
    off();
    stop();
  });

  it('matches the day in local time, across midnight and by the cards that hold the second', () => {
    const cards = [{ start: new Date(at('2026-10-03T23:59:30')).toISOString(), end: new Date(at('2026-10-04T00:01:00')).toISOString() }];
    const cached = new Map([['den|2026-10-03', { events: cards as never, downloads: 'ok' as const }]]);
    // 02:00 UTC on the 4th is 21:00 on the 3rd in Chicago.
    expect(affectedDays('den', Date.parse('2026-10-04T02:00:00Z'), new Map())).toEqual(['2026-10-03']);
    // A second just after midnight: its card may have started the day before.
    expect(affectedDays('den', at('2026-10-04T00:00:03'), new Map())).toEqual(['2026-10-04', '2026-10-03']);
    // A card of the 3rd running past midnight holds a second well into the 4th.
    expect(affectedDays('den', at('2026-10-04T00:00:50'), cached)).toEqual(['2026-10-04', '2026-10-03']);
    expect(affectedDays('den', at('2026-10-04T00:00:50'), new Map())).toEqual(['2026-10-04']);
    // Not for another camera's cards.
    expect(affectedDays('yard', at('2026-10-04T00:00:50'), cached)).toEqual(['2026-10-04']);
    // Without a time: every cached day of the camera.
    expect(affectedDays('den', null, cached)).toEqual(['2026-10-03']);
  });

  it('an answer on its way when the day changed fills an empty cache only, and the day stays stale', async () => {
    const s = fakeStream();
    const stop = followDayChanges(s);
    let answer!: (v: unknown) => void;
    const slow = vi.fn(() => new Promise((r) => (answer = r)));
    const p = loadDay('den', '2026-10-03', { fetch: asFetch(slow) });
    s.fire({ cam: 'den', type: 'analysis', ts: at('2026-10-03T21:21:56') });
    answer(day());
    await p;
    expect(get(dayStore).has('den|2026-10-03')).toBe(true);
    const fresh = vi.fn(async () => day());
    await loadDay('den', '2026-10-03', { fetch: asFetch(fresh) });
    expect(fresh).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('dayCache refresh', () => {
  it('keeps the cached object when a forced load answers the same', async () => {
    const fetch = vi.fn(async () => ({ events: [{ id: 'a', start: '2026-10-03T10:00:00Z', end: '2026-10-03T10:00:20Z' }], downloads: 'ok' }));
    const first = await loadDay('den', '2026-10-03', { fetch: asFetch(fetch) });
    const again = await loadDay('den', '2026-10-03', { fetch: asFetch(fetch), force: true });
    expect(again).toBe(first);
    expect(get(dayStore).get('den|2026-10-03')).toBe(first);
  });
});
