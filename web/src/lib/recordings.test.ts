// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_KINDS, addDays, cursorSearch, isAllKinds, parseFilter, toggleFilter, downloadUrl, filterEvents, groupByHour,
  loadCursor, orderTriggers, parseCursor, saveCursor, thumbUrl, videoUrl,
  type EventClip,
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
  it('adds days across month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });
});

describe('filters and formatting', () => {
  it('filters by trigger', () => {
    expect(filterEvents(events, ['person']).map((e) => e.id)).toEqual([events[0].id]);
    expect(filterEvents(events, ALL_KINDS)).toHaveLength(3);
  });
  it('filters by several triggers (multi-select, Klaus 2026-09-28)', () => {
    const kinds = events.map((e) => e.triggers);
    const want = events.filter((_, i) => kinds[i].some((k) => k === 'person' || k === 'motion')).map((e) => e.id);
    expect(filterEvents(events, ['person', 'motion']).map((e) => e.id)).toEqual(want);
  });
  it('reads a filter: all, one kind, several, old values, junk', () => {
    expect(parseFilter('all')).toEqual(ALL_KINDS);
    expect(parseFilter('person')).toEqual(['person']);
    expect(parseFilter('vehicle,person')).toEqual(['person', 'vehicle']); // canonical order
    expect(parseFilter(['pet', 'motion'])).toEqual(['pet', 'motion']);
    expect(parseFilter('zzz')).toEqual(ALL_KINDS);
    expect(parseFilter(null)).toEqual(ALL_KINDS);
    expect(isAllKinds(ALL_KINDS)).toBe(true);
    expect(isAllKinds(['person'])).toBe(false);
  });
  it('toggles chips: from All a kind picks only it; the last one off is All again', () => {
    expect(toggleFilter(ALL_KINDS, 'person')).toEqual(['person']);
    expect(toggleFilter(['person'], 'vehicle')).toEqual(['person', 'vehicle']);
    expect(toggleFilter(['person', 'vehicle'], 'person')).toEqual(['vehicle']);
    expect(toggleFilter(['vehicle'], 'vehicle')).toEqual(ALL_KINDS);
    expect(toggleFilter(['vehicle'], 'all')).toEqual(ALL_KINDS);
  });
});

describe('URL builders', () => {
  it('escapes ids and dates that contain path-breaking characters', () => {
    expect(videoUrl('cam1', '../etc/passwd')).toBe('/api/cameras/cam1/clips/..%2Fetc%2Fpasswd/video');
    expect(thumbUrl('cam1', 'a/b')).toBe('/api/cameras/cam1/clips/a%2Fb/thumb.jpg');
    expect(downloadUrl('cam1', '../x', 'sub')).toBe('/api/cameras/cam1/clips/..%2Fx/download?quality=sub');
  });
});

describe('cursor', () => {
  it('parses and serialises the URL cursor', () => {
    const q = cursorSearch('cam1', { date: DAY, clipId: events[0].id, offsetSec: 12.4, at: null }, 'events', ['person', 'pet']);
    expect(q).toBe(`?cam=cam1&date=${DAY}&clip=${events[0].id}&t=12&panel=events&filter=person%2Cpet`);
    expect(parseCursor(new URLSearchParams(q), '2026-09-26')).toEqual({
      cam: 'cam1', cursor: { date: DAY, clipId: events[0].id, offsetSec: 12, at: null }, filter: ['person', 'pet'],
    });
  });

  it('defaults to today and ignores malformed values', () => {
    expect(parseCursor(new URLSearchParams('?date=bad&clip=../x&t=-4&filter=zzz'), '2026-09-26')).toEqual({
      cam: null, cursor: { date: '2026-09-26', clipId: null, offsetSec: 0, at: null }, filter: ALL_KINDS,
    });
  });

  it('remembers the last cursor in sessionStorage and survives storage errors', () => {
    saveCursor('cam1', { date: DAY, clipId: events[0].id, offsetSec: 3, at: 1790552160000 });
    expect(loadCursor()).toEqual({ cam: 'cam1', cursor: { date: DAY, clipId: events[0].id, offsetSec: 3, at: 1790552160000 } });
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } });
    expect(() => saveCursor('cam1', { date: DAY, clipId: null, offsetSec: 0, at: null })).not.toThrow();
    expect(loadCursor()).toBeNull();
  });

  it('rejects a corrupted stored cursor', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify({ cam: 'cam1', cursor: { date: DAY, clipId: '../x', offsetSec: 3 } }),
      setItem: () => {},
    });
    expect(loadCursor()).toBeNull();

    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify({ cam: '', cursor: { date: DAY, clipId: null, offsetSec: 3 } }),
      setItem: () => {},
    });
    expect(loadCursor()).toBeNull();

    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify({ cam: 'cam1', cursor: { date: 'bad', clipId: null, offsetSec: 3 } }),
      setItem: () => {},
    });
    expect(loadCursor()).toBeNull();

    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify({ cam: 'cam1', cursor: { date: DAY, clipId: null, offsetSec: -1 } }),
      setItem: () => {},
    });
    expect(loadCursor()).toBeNull();

    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify({ cam: 'cam1', cursor: { date: DAY, clipId: null, offsetSec: 'nope' } }),
      setItem: () => {},
    });
    expect(loadCursor()).toBeNull();
  });
});

describe('groupByHour', () => {
  // Spring forward (2026-03-08): 02:00 doesn't exist, so the 03:xx hour starts
  // two hours after midnight; its label comes from the hour, not the offset.
  it('labels the hour after spring-forward by its wall clock', () => {
    const g = groupByHour([E('20260308-031500-031520', '2026-03-08T03:15:00-05:00', '2026-03-08T03:15:20-05:00', ['motion'])], '2026-03-08');
    expect(g.map((x) => [x.hour, x.label])).toEqual([[3, '03:00–04:00']]);
  });

  // Fall back (2026-11-01): 01:xx happens twice, and both are one group.
  it('labels the repeated fall-back hour by its wall clock', () => {
    const g = groupByHour(
      [
        E('20261101-011500-011520', '2026-11-01T01:15:00-05:00', '2026-11-01T01:15:20-05:00', ['motion']),
        E('20261101-011500-011520b', '2026-11-01T01:15:00-06:00', '2026-11-01T01:15:20-06:00', ['motion']),
      ],
      '2026-11-01',
    );
    expect(g.map((x) => [x.hour, x.label, x.events.length])).toEqual([[1, '01:00–02:00', 2]]);
  });

  it('groups by local hour, newest first, skipping empty hours (Klaus, 2026-09-28)', () => {
    const g = groupByHour(events, DAY); // the three fixtures at 08:15, 12:05, 17:45
    expect(g.map((x) => [x.hour, x.label, x.events.length])).toEqual([
      [17, '17:00–18:00', 1],
      [12, '12:00–13:00', 1],
      [8, '08:00–09:00', 1],
    ]);
  });

  it('lists an hour’s events newest first', () => {
    const two = [
      E('20260925-140010-140020', `${DAY}T14:00:10-05:00`, `${DAY}T14:00:20-05:00`, ['motion']),
      E('20260925-145000-145010', `${DAY}T14:50:00-05:00`, `${DAY}T14:50:10-05:00`, ['person']),
    ];
    expect(groupByHour(two, DAY)[0].events.map((e) => e.id)).toEqual(['20260925-145000-145010', '20260925-140010-140020']);
  });

  it('keeps a busy hour together', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      E(`20260925-1400${String(i).padStart(2, '0')}-1400${String(i + 1).padStart(2, '0')}`, `${DAY}T14:00:${String(i).padStart(2, '0')}-05:00`, `${DAY}T14:00:${String(i + 1).padStart(2, '0')}-05:00`, ['motion']),
    );
    const g = groupByHour(many, DAY);
    expect(g).toHaveLength(1);
    expect(g[0].events).toHaveLength(25);
  });
});

describe('the strip position in the URL', () => {
  it('reads at, and old links without it', () => {
    const p = parseCursor(new URLSearchParams('cam=den&date=2026-09-27&at=1790552160000&clip=20260927-120505-120530'), '2026-09-27');
    expect(p.cursor.at).toBe(1790552160000);
    const old = parseCursor(new URLSearchParams('cam=den&date=2026-09-27&clip=20260927-120505-120530&t=7'), '2026-09-27');
    expect(old.cursor).toEqual({ date: '2026-09-27', clipId: '20260927-120505-120530', offsetSec: 7, at: null });
  });

  it('writes at and the clip under the playhead, no t', () => {
    const s = cursorSearch('den', { date: '2026-09-27', clipId: '20260927-120505-120530', offsetSec: 0, at: 1790552160000 }, 'history', ALL_KINDS);
    expect(s).toBe('?cam=den&date=2026-09-27&at=1790552160000&clip=20260927-120505-120530&panel=history&filter=all');
  });
});

describe('orderTriggers', () => {
  it('shows Motion first, then Person, Vehicle, Pet, Scheduled (Klaus, 2026-10-01)', () => {
    expect(orderTriggers(['person', 'motion'])).toEqual(['motion', 'person']);
    expect(orderTriggers(['timer', 'pet', 'vehicle', 'person', 'motion'])).toEqual(['motion', 'person', 'vehicle', 'pet', 'timer']);
    expect(orderTriggers([])).toEqual([]);
  });

  it('keeps unknown kinds after the known ones, in their order, and leaves the input alone', () => {
    const input = ['face', 'person', 'motion', 'doorbell'];
    expect(orderTriggers(input)).toEqual(['motion', 'person', 'face', 'doorbell']);
    expect(input).toEqual(['face', 'person', 'motion', 'doorbell']);
  });
});
