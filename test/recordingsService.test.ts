import { describe, expect, it } from 'vitest';
import { byStartTime, isRecentDay, pickStream } from '../server/recordings/service';

// Fix round 1, item 6: TODAY_TTL must cover today AND the trailing 24h
// window, not just an exact string match against "today", so the
// DST-enabled-but-inactive hour and the last minutes before local midnight
// still get the short TTL.
describe('isRecentDay', () => {
  it('treats today (offset 0) as recent', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    expect(isRecentDay('2026-06-15', 0, now)).toBe(true);
  });

  it('treats yesterday as recent too (the day boundary window)', () => {
    const now = Date.parse('2026-06-15T00:05:00Z'); // just after UTC midnight
    expect(isRecentDay('2026-06-14', 0, now)).toBe(true);
  });

  it('treats two days ago as not recent', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    expect(isRecentDay('2026-06-13', 0, now)).toBe(false);
  });

  it('applies the camera\'s UTC offset, not UTC, when deciding "today"', () => {
    // now is 2026-06-15T02:00:00Z; at offset -300 (UTC-5) that's still
    // 2026-06-14 camera-local, so camera-local "yesterday" is 06-13.
    const now = Date.parse('2026-06-15T02:00:00Z');
    expect(isRecentDay('2026-06-14', -300, now)).toBe(true); // camera-local today
    expect(isRecentDay('2026-06-13', -300, now)).toBe(true); // camera-local yesterday
    expect(isRecentDay('2026-06-12', -300, now)).toBe(false);
  });
});

// Fix round 1, item 9: the filename's quality suffix must name the stream
// actually served, not the one requested, when it falls back.
describe('pickStream', () => {
  it('serves the requested quality when it exists', () => {
    expect(pickStream('sub', { sub: 'a.mp4', main: 'b.mp4' })).toEqual({ name: 'a.mp4', served: 'sub' });
    expect(pickStream('main', { sub: 'a.mp4', main: 'b.mp4' })).toEqual({ name: 'b.mp4', served: 'main' });
  });

  it('falls back to the other stream and reports the stream actually served', () => {
    expect(pickStream('main', { sub: 'a.mp4' })).toEqual({ name: 'a.mp4', served: 'sub' });
    expect(pickStream('sub', { main: 'b.mp4' })).toEqual({ name: 'b.mp4', served: 'main' });
  });

  it('returns null when neither stream exists', () => {
    expect(pickStream('sub', {})).toBeNull();
  });
});

// M3: string order on `start` gets the fall-back night wrong, since
// "01:10...-06:00" sorts before "01:30...-05:00" even though 01:30 CDT
// (06:30 UTC) happens before 01:10 CST (07:10 UTC).
describe('byStartTime', () => {
  it('orders clips by real time, not by their start string, across a DST fall-back', () => {
    const later = { start: '2026-11-01T01:10:00-06:00' }; // 07:10 UTC
    const earlier = { start: '2026-11-01T01:30:00-05:00' }; // 06:30 UTC
    expect(byStartTime(earlier, later)).toBeLessThan(0);
    expect([later, earlier].sort(byStartTime)).toEqual([earlier, later]);
  });
});
