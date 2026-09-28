// web/src/lib/dayCache.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { dayStore, loadDay, resetDayCache, type Fetch } from './dayCache';

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
});
