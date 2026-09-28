// web/src/components/HistoryView.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HistoryView from './HistoryView.svelte';
import { resetDayCache } from '../lib/dayCache';
import { preferences } from '../lib/preferences';

// TZ=America/Chicago; the clock is 2026-09-27 20:00 CDT.
const NOW = Date.parse('2026-09-27T20:00:00-05:00');
const E1 = { id: '20260927-081510-081535', start: '2026-09-27T13:15:10.000Z', end: '2026-09-27T13:15:35.000Z', durationSec: 25, triggers: ['person'], sizeSub: 1, sizeMain: 1 };
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  resetDayCache();
  preferences.set({ defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 1, liveKeepAlive: 60 });
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('fetch', async (url: string) => {
    const body = url.includes('/events?date=2026-09-27') ? { events: [E1], downloads: 'ok' } : url.includes('/events?') ? { events: [], downloads: 'ok' } : [];
    return new Response(JSON.stringify(body), { status: 200 });
  });
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  preferences.set(null);
});
async function render(extra: Record<string, unknown> = {}) {
  const onposition = vi.fn();
  const props = $state({ cam: 'den', proxy: false, date: '2026-09-27', initialAt: null as number | null, visibleIds: new Set<string>(), unavailable: false, onposition, ...extra });
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(HistoryView, { target, props });
  await vi.advanceTimersByTimeAsync(10);
  flushSync();
  return { props, onposition };
}

describe('HistoryView', () => {
  it('opens on the day’s first event when the URL has no position', async () => {
    const { onposition } = await render();
    expect(onposition).toHaveBeenLastCalledWith(Date.parse(E1.start), E1.id);
  });

  it('opens at the URL position', async () => {
    const at = Date.parse('2026-09-27T10:00:00-05:00');
    const { onposition } = await render({ initialAt: at });
    expect(onposition).toHaveBeenLastCalledWith(at, null);
  });

  it('jumps when the page’s date changes to another day, to 00:00 without events', async () => {
    const { props, onposition } = await render();
    props.date = '2026-09-25';
    await vi.advanceTimersByTimeAsync(10);
    flushSync();
    expect(onposition).toHaveBeenLastCalledWith(new Date(2026, 8, 25).getTime(), null);
  });

  it('reports the position at most every 2 s while playing', async () => {
    const at = Date.parse('2026-09-27T10:00:00-05:00');
    const { onposition } = await render({ initialAt: at });
    onposition.mockClear();
    (target!.querySelector('[data-testid="play-toggle"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onposition.mock.calls.length).toBeLessThanOrEqual(3);
    expect(onposition.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
