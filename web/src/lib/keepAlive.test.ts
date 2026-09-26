import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeepAlive } from './keepAlive';

afterEach(() => vi.useRealTimers());

describe('createKeepAlive', () => {
  it('expires after the chosen time', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const k = createKeepAlive(expire);
    k.leave(60);
    vi.advanceTimersByTime(59_999);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('coming back in time cancels the expiry', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const k = createKeepAlive(expire);
    k.leave(30);
    vi.advanceTimersByTime(10_000);
    k.enter();
    vi.advanceTimersByTime(60_000);
    expect(expire).not.toHaveBeenCalled();
  });

  it('off means stop at once', () => {
    const expire = vi.fn();
    createKeepAlive(expire).leave(0);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('a second leave restarts the countdown instead of stacking', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const k = createKeepAlive(expire);
    k.leave(30);
    vi.advanceTimersByTime(20_000);
    k.leave(30);
    vi.advanceTimersByTime(20_000);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels a pending expiry', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const k = createKeepAlive(expire);
    k.leave(30);
    k.dispose();
    vi.advanceTimersByTime(60_000);
    expect(expire).not.toHaveBeenCalled();
  });
});
