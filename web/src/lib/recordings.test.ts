// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays, clipAtSecond, cursorSearch, filterEvents, formatBytes, layoutSegments, loadCursor, neighbour,
  parseCursor, saveCursor, secondsIntoDay, timelineWindow, type EventClip,
} from './recordings';

// Tests run with TZ=America/Chicago (vitest.config.mts env); clip times use -05:00.
const E = (id: string, start: string, end: string, triggers: EventClip['triggers']): EventClip => ({
  id, start, end, durationSec: 25, triggers, sizeSub: 100, sizeMain: 1000,
});
const DAY = '2026-09-25';
const events = [
  E('20260925-081510-081535', `${DAY}T08:15:10-05:00`, `${DAY}T08:15:35-05:00`, ['person']),
  E('20260925-120505-120530', `${DAY}T12:05:05-05:00`, `${DAY}T12:05:30-05:00`, ['motion']),
  E('20260925-174540-174605', `${DAY}T17:45:40-05:00`, `${DAY}T17:46:05-05:00`, ['pet']),
];

afterEach(() => vi.unstubAllGlobals());

describe('time helpers', () => {
  it('computes seconds into the local day', () => {
    expect(secondsIntoDay(events[0].start, DAY)).toBe(8 * 3600 + 15 * 60 + 10);
  });
  it('adds days across month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });
});

describe('timeline', () => {
  it('shows the whole day at 24 h and clamps narrower windows to the day', () => {
    expect(timelineWindow(24, 50_000)).toEqual({ start: 0, end: 86400 });
    expect(timelineWindow(1, 600)).toEqual({ start: 0, end: 3600 });
    expect(timelineWindow(1, 86000)).toEqual({ start: 82800, end: 86400 });
    expect(timelineWindow(6, 43200)).toEqual({ start: 32400, end: 54000 });
  });

  it('lays out segments inside the window with AI marked', () => {
    const segs = layoutSegments(events, DAY, { start: 0, end: 86400 });
    expect(segs).toHaveLength(3);
    expect(segs[0].ai).toBe(true);
    expect(segs[1].ai).toBe(false);
    expect(segs[0].left).toBeCloseTo(((8 * 3600 + 15 * 60 + 10) / 86400) * 100, 3);
    expect(segs[0].width).toBeGreaterThanOrEqual(0.4);
  });

  it('drops segments outside the window', () => {
    expect(layoutSegments(events, DAY, { start: 43200, end: 46800 }).map((s) => s.id)).toEqual(['20260925-120505-120530']);
  });

  it('finds the clip under a click, or the nearest start within 5 minutes', () => {
    expect(clipAtSecond(events, DAY, 12 * 3600 + 5 * 60 + 20)?.id).toBe('20260925-120505-120530');
    expect(clipAtSecond(events, DAY, 12 * 3600 + 2 * 60)?.id).toBe('20260925-120505-120530');
    expect(clipAtSecond(events, DAY, 3 * 3600)).toBeNull();
  });

  it('steps to neighbours', () => {
    expect(neighbour(events, events[1].id, 1)?.id).toBe(events[2].id);
    expect(neighbour(events, events[1].id, -1)?.id).toBe(events[0].id);
    expect(neighbour(events, events[2].id, 1)).toBeNull();
  });
});

describe('filters and formatting', () => {
  it('filters by trigger', () => {
    expect(filterEvents(events, 'person').map((e) => e.id)).toEqual([events[0].id]);
    expect(filterEvents(events, 'all')).toHaveLength(3);
  });
  it('formats sizes', () => {
    expect(formatBytes(600_009)).toBe('586 KB');
    expect(formatBytes(17_559_552)).toBe('16.7 MB');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('cursor', () => {
  it('parses and serialises the URL cursor', () => {
    const q = cursorSearch('cam1', { date: DAY, clipId: events[0].id, offsetSec: 12.4 }, 'events', 'person');
    expect(q).toBe(`?cam=cam1&date=${DAY}&clip=${events[0].id}&t=12&panel=events&filter=person`);
    expect(parseCursor(new URLSearchParams(q), '2026-09-26')).toEqual({
      cam: 'cam1', cursor: { date: DAY, clipId: events[0].id, offsetSec: 12 }, filter: 'person',
    });
  });

  it('defaults to today and ignores malformed values', () => {
    expect(parseCursor(new URLSearchParams('?date=bad&clip=../x&t=-4&filter=zzz'), '2026-09-26')).toEqual({
      cam: null, cursor: { date: '2026-09-26', clipId: null, offsetSec: 0 }, filter: 'all',
    });
  });

  it('remembers the last cursor in sessionStorage and survives storage errors', () => {
    saveCursor('cam1', { date: DAY, clipId: events[0].id, offsetSec: 3 });
    expect(loadCursor()).toEqual({ cam: 'cam1', cursor: { date: DAY, clipId: events[0].id, offsetSec: 3 } });
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } });
    expect(() => saveCursor('cam1', { date: DAY, clipId: null, offsetSec: 0 })).not.toThrow();
    expect(loadCursor()).toBeNull();
  });
});
