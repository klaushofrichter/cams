import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { formatNow, now, timeZoneLabel } from './clock';

describe('clock', () => {
  it('shows 24-hour time with seconds and the time zone', () => {
    expect(formatNow(new Date('2026-09-26T19:32:05Z'), 'en-US')).toBe('14:32:05 CDT');
    expect(formatNow(new Date('2026-01-10T06:02:09Z'), 'en-US')).toBe('00:02:09 CST');
    expect(timeZoneLabel(new Date('2026-09-26T19:32:05Z'), 'en-US')).toBe('CDT');
  });

  it('ticks on whole seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T19:32:05.600Z'));
    const seen: string[] = [];
    const stop = now.subscribe((d) => seen.push(d.toISOString()));
    vi.advanceTimersByTime(400); // reaches :06.000
    vi.advanceTimersByTime(1000);
    stop();
    vi.useRealTimers();
    expect(seen.slice(-2)).toEqual(['2026-09-26T19:32:06.000Z', '2026-09-26T19:32:07.000Z']);
    expect(get(now)).toBeInstanceOf(Date);
  });
});
