import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { formatNow, now, timeAgo, timeZoneLabel } from './clock';

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

describe('timeAgo (Klaus, 2026-09-28: roughly how long ago)', () => {
  const NOW = Date.parse('2026-09-28T12:00:00Z');
  it('says just now under a minute, then minutes, hours and days, rounded down', () => {
    expect(timeAgo(NOW - 30_000, NOW)).toBe('just now');
    expect(timeAgo(NOW + 5_000, NOW)).toBe('just now'); // a camera clock a little ahead
    expect(timeAgo(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(timeAgo(NOW - 45 * 60_000, NOW)).toBe('45 minutes ago');
    expect(timeAgo(NOW - 60 * 60_000, NOW)).toBe('1 hour ago');
    expect(timeAgo(NOW - 14.7 * 3_600_000, NOW)).toBe('14 hours ago');
    expect(timeAgo(NOW - 24 * 3_600_000, NOW)).toBe('1 day ago');
    expect(timeAgo(NOW - 2.9 * 86_400_000, NOW)).toBe('2 days ago');
  });
});

