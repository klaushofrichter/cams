// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTodayRefresher } from './refresh';

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
    createTodayRefresher({ isToday: () => false, refresh, intervalMs: 1000 }).stop;
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();
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
