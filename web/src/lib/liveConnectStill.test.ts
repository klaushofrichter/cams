// Klaus, 2026-10-06: while the live view connects, a still from the camera
// gateway that is less than 60 s old shows in the player instead of black.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideStill, FRESH_STILL_MS, isFreshStill, keepPolling, STILL_SKEW_MS, whenPainted } from './liveConnectStill';

const NOW = Date.parse('2026-10-06T12:00:00Z');

describe('isFreshStill', () => {
  it('takes a still less than 60 s old, by its own capture time', () => {
    expect(isFreshStill(NOW - 1_000, NOW)).toBe(true);
    expect(isFreshStill(NOW - (FRESH_STILL_MS - 1), NOW)).toBe(true);
  });
  it('leaves out one 60 s old or older', () => {
    expect(isFreshStill(NOW - FRESH_STILL_MS, NOW)).toBe(false);
    expect(isFreshStill(NOW - 90_000, NOW)).toBe(false);
  });
  it('tolerates a gateway clock a little ahead of the browser', () => {
    expect(isFreshStill(NOW + 5_000, NOW)).toBe(true);
    expect(isFreshStill(NOW + STILL_SKEW_MS, NOW)).toBe(true);
    expect(isFreshStill(NOW + STILL_SKEW_MS + 1, NOW)).toBe(false);
  });
  it('leaves out a still of unknown time', () => {
    expect(isFreshStill(null, NOW)).toBe(false);
  });
});

describe('decideStill', () => {
  const base = { cameraId: 'den', now: NOW };
  it('shows a fresh still while connecting', () => {
    expect(decideStill({ ...base, freshOnly: true, current: null, next: { cameraId: 'den', at: NOW - 3_000 } })).toBe('show');
  });
  it('drops a stale still while connecting (the box stays as it is today)', () => {
    expect(decideStill({ ...base, freshOnly: true, current: null, next: { cameraId: 'den', at: NOW - 61_000 } })).toBe('drop');
    expect(decideStill({ ...base, freshOnly: true, current: null, next: { cameraId: 'den', at: null } })).toBe('drop');
  });
  it('keeps the fresh one shown when a stale answer follows', () => {
    expect(decideStill({ ...base, freshOnly: true, current: { cameraId: 'den', at: NOW - 59_000 }, next: { cameraId: 'den', at: NOW - 61_000 } })).toBe('keep');
  });
  it('replaces the shown still with a newer one', () => {
    expect(decideStill({ ...base, freshOnly: true, current: { cameraId: 'den', at: NOW - 5_000 }, next: { cameraId: 'den', at: NOW - 1_000 } })).toBe('show');
  });
  it('keeps the shown still when the answer is the same still (no flicker)', () => {
    expect(decideStill({ ...base, freshOnly: true, current: { cameraId: 'den', at: NOW - 5_000 }, next: { cameraId: 'den', at: NOW - 5_000 } })).toBe('keep');
  });
  it('ignores a late answer for the camera switched away from', () => {
    expect(decideStill({ ...base, cameraId: 'porch', freshOnly: true, current: null, next: { cameraId: 'den', at: NOW - 1_000 } })).toBe('drop');
    expect(decideStill({ ...base, cameraId: 'porch', freshOnly: false, current: null, next: { cameraId: 'den', at: NOW - 1_000 } })).toBe('drop');
  });
  it('replaces a still of another camera at once', () => {
    expect(decideStill({ ...base, freshOnly: true, current: { cameraId: 'porch', at: NOW }, next: { cameraId: 'den', at: NOW - 30_000 } })).toBe('show');
  });
  it('shows any still once the 5 s fallback runs (as before)', () => {
    expect(decideStill({ ...base, freshOnly: false, current: null, next: { cameraId: 'den', at: NOW - 100_000 } })).toBe('show');
    expect(decideStill({ ...base, freshOnly: false, current: null, next: { cameraId: 'den', at: null } })).toBe('show');
  });
});

describe('keepPolling', () => {
  it('asks once on connect, and again only while a fresh still shows', () => {
    expect(keepPolling({ freshOnly: true, asked: 0, showing: false })).toBe(true);
    expect(keepPolling({ freshOnly: true, asked: 1, showing: false })).toBe(false);
    expect(keepPolling({ freshOnly: true, asked: 1, showing: true })).toBe(true);
  });
  it('polls every time once the 5 s fallback runs', () => {
    expect(keepPolling({ freshOnly: false, asked: 7, showing: false })).toBe(true);
  });
});

describe('whenPainted', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for the video frame to be presented', () => {
    let frame: (() => void) | null = null;
    const video = { requestVideoFrameCallback: (cb: () => void) => ((frame = cb), 1), cancelVideoFrameCallback: () => undefined } as unknown as HTMLVideoElement;
    const done = vi.fn();
    whenPainted(video, done);
    expect(done).not.toHaveBeenCalled();
    frame!();
    expect(done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('falls back to two animation frames without requestVideoFrameCallback', () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const done = vi.fn();
    whenPainted({} as HTMLVideoElement, done);
    frames.shift()!();
    expect(done).not.toHaveBeenCalled();
    frames.shift()!();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after a short time (a hidden tab paints nothing)', () => {
    const video = { requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => undefined } as unknown as HTMLVideoElement;
    const done = vi.fn();
    whenPainted(video, done, 300);
    vi.advanceTimersByTime(299);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled (the stream stopped meanwhile)', () => {
    let frame: (() => void) | null = null;
    const video = { requestVideoFrameCallback: (cb: () => void) => ((frame = cb), 1), cancelVideoFrameCallback: () => undefined } as unknown as HTMLVideoElement;
    const done = vi.fn();
    const cancel = whenPainted(video, done);
    cancel();
    frame!();
    vi.advanceTimersByTime(1_000);
    expect(done).not.toHaveBeenCalled();
  });
});
