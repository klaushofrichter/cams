// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTodayRefresher, todayDate } from './refresh';

afterEach(() => vi.useRealTimers());

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('createTodayRefresher', () => {
  it('refreshes every interval while viewing today', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const r = createTodayRefresher({ isToday: () => true, refresh, intervalMs: 1000 });
    vi.advanceTimersByTime(3500);
    expect(refresh).toHaveBeenCalledTimes(3);
    r.stop();
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('never refreshes a past day', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const r = createTodayRefresher({ isToday: () => false, refresh, intervalMs: 1000 });
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();
    r.stop();
  });

  it('pauses while hidden and catches up when the tab comes back', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const r = createTodayRefresher({ isToday: () => true, refresh, intervalMs: 60_000 });
    setHidden(true);
    vi.advanceTimersByTime(180_000);
    expect(refresh).not.toHaveBeenCalled();
    setHidden(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    r.stop();
  });
});

describe('todayDate', () => {
  // Fix round 1, item 5: with no subscribers, the readable store's start
  // function doesn't rerun until someone subscribes again, so its value
  // otherwise stays whatever it was on the LAST subscribe -- stale once the
  // wall clock has since crossed midnight while nobody was listening.
  it('holds the new day when resubscribed after being idle across a day boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 55));
    const unsub1 = todayDate.subscribe(() => {});
    unsub1(); // no subscribers left: the store's start() stops running

    vi.setSystemTime(new Date(2026, 0, 16, 0, 5)); // idle across midnight

    let value = '';
    const unsub2 = todayDate.subscribe((v) => (value = v));
    expect(value).toBe('2026-01-16');
    unsub2();
  });
});
