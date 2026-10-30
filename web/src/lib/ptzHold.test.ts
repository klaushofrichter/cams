import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHold, HOLD_MS, REPEAT_MS, TAP_MS, type Hold } from './ptzHold';

// Tap and hold on a PTZ button (spec 2026-10-30-ptz-capabilities-design §5.1):
// a tap is one short move; a hold repeats longer moves until released.
let calls: string[];
let errors: unknown[];
let h: Hold;
let failFrom: number;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  errors = [];
  failFrom = Infinity;
  let n = 0;
  h = createHold({
    start: (ms) => {
      calls.push(`start ${ms}`);
      return ++n >= failFrom ? Promise.reject(new Error('offline')) : Promise.resolve();
    },
    stop: () => (calls.push('stop'), Promise.resolve()),
    onError: (e) => errors.push(e),
  });
});
afterEach(() => vi.useRealTimers());

describe('createHold', () => {
  it('has the spec timings', () => expect([TAP_MS, HOLD_MS, REPEAT_MS]).toEqual([400, 600, 250]));

  it('a tap is one 400 ms move and no stop', () => {
    h.press();
    vi.advanceTimersByTime(100);
    h.release();
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(['start 400']);
    expect(h.active()).toBe(false);
  });

  it('a hold repeats 600 ms moves every 250 ms, then stops on release', () => {
    h.press();
    vi.advanceTimersByTime(800);
    h.release();
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(['start 400', 'start 600', 'start 600', 'start 600', 'stop']);
  });

  it('cancel stops even a tap', () => {
    h.press();
    h.cancel();
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual(['start 400', 'stop']);
  });

  it('cancel and release without a press do nothing', () => {
    h.cancel();
    h.release();
    expect(calls).toEqual([]);
  });

  it('a second press while active is ignored', () => {
    h.press();
    h.press();
    vi.advanceTimersByTime(100);
    h.press();
    h.release();
    expect(calls).toEqual(['start 400']);
  });

  it('a failing start ends the hold: no more starts, one stop, the error reported', async () => {
    failFrom = 3;
    h.press();
    await vi.advanceTimersByTimeAsync(600); // starts 1, 2 (at 250), 3 (at 500) fails
    await vi.advanceTimersByTimeAsync(2000);
    h.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((c) => c.startsWith('start'))).toHaveLength(3);
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(h.active()).toBe(false);
  });

  it('a failing tap reports the error and sends no stop', async () => {
    failFrom = 1;
    h.press();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(['start 400']);
    expect(errors).toHaveLength(1);
    expect(h.active()).toBe(false);
  });

  it('a failing stop is reported too', async () => {
    const errs: unknown[] = [];
    const x = createHold({ start: () => Promise.resolve(), stop: () => Promise.reject(new Error('gone')), onError: (e) => errs.push(e) });
    x.press();
    x.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(errs).toHaveLength(1);
  });
});
