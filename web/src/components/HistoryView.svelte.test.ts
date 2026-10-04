// web/src/components/HistoryView.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HistoryView from './HistoryView.svelte';
import { resetDayCache } from '../lib/dayCache';
import { preferences } from '../lib/preferences';
import { ALL_KINDS, type Filter } from '../lib/recordings';

// TZ=America/Chicago; the clock is 2026-09-27 20:00 CDT.
const NOW = Date.parse('2026-09-27T20:00:00-05:00');
const E1 = { id: '20260927-081510-081535', start: '2026-09-27T13:15:10.000Z', end: '2026-09-27T13:15:35.000Z', durationSec: 25, triggers: ['person'], sizeSub: 1, sizeMain: 1 };
const E2 = { id: '20260927-093000-093020', start: '2026-09-27T14:30:00.000Z', end: '2026-09-27T14:30:20.000Z', durationSec: 20, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
const E3 = { id: '20260927-120000-120030', start: '2026-09-27T17:00:00.000Z', end: '2026-09-27T17:00:30.000Z', durationSec: 30, triggers: ['person'], sizeSub: 1, sizeMain: 1 };
const requested: string[] = [];
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  resetDayCache();
  preferences.set({ defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 1, liveKeepAlive: 60 });
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  requested.length = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    if (url.includes('/extent')) return new Response(JSON.stringify({ oldest: Date.parse(E1.start) - 3 * 86_400_000 }), { status: 200 });
    const body = url.includes('/events?date=2026-09-27') ? { events: [E1, E2, E3], downloads: 'ok' } : url.includes('/events?') ? { events: [], downloads: 'ok' } : [];
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
  const props = $state({ cam: 'den', proxy: false, date: '2026-09-27', initialAt: null as number | null, filter: ALL_KINDS as Filter, live: false, unavailable: false, onposition, ...extra });
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

  // Review fix: a position from outside ("Open in History" while playing) lands paused;
  // a card's click still plays.
  it('pauses on a jump from outside, plays on a jump that asks to', async () => {
    const at = Date.parse('2026-09-27T10:00:00-05:00');
    await render({ initialAt: at });
    const toggle = () => target!.querySelector('[data-testid="play-toggle"]') as HTMLElement;
    toggle().click();
    flushSync();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    const view = component as unknown as { jump: (t: number, play?: boolean) => void };
    view.jump(at + 60_000);
    flushSync();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    view.jump(at + 120_000, true);
    flushSync();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a failed clip on the strip, marked failed (review #7)', async () => {
    await render({ initialAt: Date.parse(E1.start) + 1000 });
    (target!.querySelector('[data-testid="clip-video"]') as HTMLElement).dispatchEvent(new Event('error'));
    flushSync();
    const seg = target!.querySelector(`[data-testid="timeline-seg"][data-clip-id="${E1.id}"]`);
    expect(seg).not.toBeNull();
    expect(seg!.classList.contains('failed')).toBe(true);
  });

  it('reports at most every 2 s while scrolling the strip, and once more when it stops (review #8, #12)', async () => {
    const { onposition } = await render({ initialAt: Date.parse(E1.start) });
    onposition.mockClear();
    const bar = target!.querySelector('[data-testid="timeline"]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 46, right: 600, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
    for (let i = 0; i < 20; i++) {
      bar.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(onposition.mock.calls.length).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(2500);
    const last = onposition.mock.calls.at(-1)![0];
    expect(last).toBe(Date.parse(E1.start) + 20 * (10 / 600) * 3_600_000);
  });

  it('places the playhead at once on a day already loaded (review #9)', async () => {
    const { props, onposition } = await render();
    props.date = '2026-09-26';
    await vi.advanceTimersByTimeAsync(10);
    props.date = '2026-09-27';
    flushSync();
    expect(onposition).toHaveBeenLastCalledWith(Date.parse(E1.start), E1.id);
  });

  it('steps to the next event the filter shows, on any day (review #14)', async () => {
    const { onposition } = await render({ initialAt: Date.parse(E1.start), filter: ['person'] as Filter });
    (target!.querySelector('[data-testid="next-clip"]') as HTMLElement).click();
    flushSync();
    expect(onposition).toHaveBeenLastCalledWith(Date.parse(E3.start), E3.id);
  });

  it('asks again for today\'s stills while paused, so they keep up (review #6)', async () => {
    await render({ proxy: true, initialAt: NOW - 60_000 });
    const n = () => requested.filter((u) => u.includes('/stills?')).length;
    const before = n();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(n()).toBeGreaterThan(before);
  });

  it('knows the oldest content: ⇤ goes there, and ±10 s never passes it (Klaus, 2026-09-28)', async () => {
    const oldest = Date.parse(E1.start) - 3 * 86_400_000;
    const { onposition } = await render({ initialAt: Date.parse(E1.start) });
    (target!.querySelector('[data-testid="strip-oldest"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(2100);
    expect(onposition).toHaveBeenLastCalledWith(oldest, null);
    (target!.querySelector('[data-testid="back-10"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(2100);
    expect(onposition).toHaveBeenLastCalledWith(oldest, null);
  });
});

describe('the live end (glue, spec 2026-09-28)', () => {
  const badge = () => target!.querySelector('[data-testid="live-badge"]');
  it('opens glued on the live panel, following now', async () => {
    const { onposition } = await render({ live: true });
    expect(badge()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onposition.mock.calls.at(-1)![0]).toBeGreaterThanOrEqual(NOW + 3000 - 2000 - 1000);
  });

  it('unglues on a move back, and ⇥ glues again', async () => {
    await render({ live: true });
    (target!.querySelector('[data-testid="back-10"]') as HTMLElement).click();
    flushSync();
    expect(badge()).toBeNull();
    (target!.querySelector('[data-testid="strip-now"]') as HTMLElement).click();
    flushSync();
    expect(badge()).not.toBeNull();
  });

  it('a click on the strip at now glues again on the live panel', async () => {
    await render({ live: true });
    (target!.querySelector('[data-testid="back-10"]') as HTMLElement).click();
    flushSync();
    const bar = target!.querySelector('[data-testid="timeline"]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 46, right: 600, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 599, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: 599, bubbles: true }));
    flushSync();
    expect(badge()).not.toBeNull();
  });

  // One Video page (spec 2026-10-04): a recording after now (a camera clock
  // ahead) stays browseable; only the strip's right end is live.
  it('a click on a recording after now plays it instead of going live', async () => {
    const AHEAD = { id: '20260927-201000-201030', start: new Date(NOW + 600_000).toISOString(), end: new Date(NOW + 630_000).toISOString(), durationSec: 30, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/extent')) return new Response(JSON.stringify({ oldest: Date.parse(E1.start) }), { status: 200 });
      const body = url.includes('/events?date=2026-09-27') ? { events: [E1, E2, E3, AHEAD], downloads: 'ok' } : url.includes('/events?') ? { events: [], downloads: 'ok' } : [];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const { onposition } = await render({ live: true });
    (target!.querySelector('[data-testid="back-10"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(10);
    flushSync();
    const bar = target!.querySelector('[data-testid="timeline"]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 46, right: 600, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
    // 1 h across 600 px, the playhead (now − 10 s) in the middle: +615 s is x = 402.5.
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 402.5, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: 402.5, bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    flushSync();
    expect(badge()).toBeNull();
    expect(onposition.mock.calls.at(-1)![1]).toBe(AHEAD.id);
  });

  it('a late first load does not pull a glued Live panel out of live (final review)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/events?')) await gate;
      return base(url);
    });
    const { props } = await render({ live: false });
    props.live = true;
    flushSync();
    (target!.querySelector('[data-testid="strip-now"]') as HTMLElement).click();
    flushSync();
    expect(badge()).not.toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(50);
    flushSync();
    expect(badge()).not.toBeNull();
  });

  it('never glues on History', async () => {
    await render({ live: false, initialAt: NOW - 60_000 });
    (target!.querySelector('[data-testid="strip-now"]') as HTMLElement).click();
    flushSync();
    expect(badge()).toBeNull();
  });

  it('playback reaching now on the live panel glues again', async () => {
    await render({ live: true });
    (target!.querySelector('[data-testid="back-10"]') as HTMLElement).click();
    flushSync();
    (target!.querySelector('[data-testid="play-toggle"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(badge()).not.toBeNull();
  });
});

describe('History ⇥ and playback to Live (Klaus, 2026-09-28)', () => {
  it('⇥ while playing goes to Live', async () => {
    const onlive = vi.fn();
    await render({ live: false, initialAt: NOW - 3_600_000, onlive });
    (target!.querySelector('[data-testid="play-toggle"]') as HTMLElement).click();
    flushSync();
    (target!.querySelector('[data-testid="strip-now"]') as HTMLElement).click();
    expect(onlive).toHaveBeenCalledTimes(1);
  });

  it('⇥ while paused stays on History, at now', async () => {
    const onlive = vi.fn();
    const { onposition } = await render({ live: false, initialAt: NOW - 3_600_000, onlive });
    (target!.querySelector('[data-testid="strip-now"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(2500); // a seek's report is throttled (2 s)
    expect(onlive).not.toHaveBeenCalled();
    expect(onposition.mock.calls.at(-1)![0]).toBeGreaterThanOrEqual(NOW - 3000);
  });

  it('playback catching up with now goes to Live', async () => {
    const onlive = vi.fn();
    await render({ live: false, initialAt: NOW - 20_000, onlive });
    (target!.querySelector('[data-testid="play-toggle"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(1000);
    flushSync();
    expect(onlive).toHaveBeenCalledTimes(1);
  });
});
