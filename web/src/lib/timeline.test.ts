import { describe, expect, it } from 'vitest';
import { dayRange, hourGroups, thumbCoverage, minuteOf, previewAt, splitRange, stillIndex, tileIndex, tileStyle, timelineCursor, cursorSearch, stepMinute, cardsInMinute, cardKind, minuteKind, secondKinds, seenStills, minuteMarks, analysedSeconds, minuteIndex, type PreviewMinute } from './timeline';

// Tests run with TZ=America/Chicago (vitest.config).
const m = (minute: number, present = Array(60).fill(true)): PreviewMinute => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present, url: `/x/${minute}.jpg` });

describe('timeline helpers', () => {
  it('turns a local day into a UTC range, 23 and 25 hours on the DST days', () => {
    expect(dayRange('2026-09-27')).toEqual([Date.UTC(2026, 8, 27, 5), Date.UTC(2026, 8, 28, 5) - 1]);
    const [s1, e1] = dayRange('2026-03-08');
    expect(e1 + 1 - s1).toBe(23 * 3_600_000);
    const [s2, e2] = dayRange('2026-11-01');
    expect(e2 + 1 - s2).toBe(25 * 3_600_000);
  });

  it('finds the tile for a second, and its sprite position', () => {
    const x = m(Date.UTC(2026, 8, 27, 19, 3));
    expect(tileIndex(x, x.minute + 12_400)).toBe(12);
    expect(minuteOf(x.minute + 59_999)).toBe(x.minute);
    expect(tileStyle(x, 12, 0.5)).toBe(`background-image:url('/x/${x.minute}.jpg');background-size:800px 270px;background-position:-160px -45px;width:80px;height:45px`);
  });

  it('groups minutes by local hour', () => {
    const h14 = Date.UTC(2026, 8, 27, 19, 0); // 14:00 CDT
    const groups = hourGroups([m(h14), m(h14 + 60_000), m(h14 + 3_600_000)]);
    expect(groups.map((g) => [g.hour, g.minutes.length])).toEqual([[14, 2], [15, 1]]);
  });
});

// Final review I1: the fall-back day is 25 h, over the one-day limit of
// cam-proxy's list routes, so it is asked in parts.
describe('splitRange', () => {
  it('keeps a normal day whole and splits the 25-hour day', () => {
    const [a, b] = dayRange('2026-09-27');
    expect(splitRange(a, b)).toEqual([[a, b]]);
    const [c, d] = dayRange('2026-11-01');
    const parts = splitRange(c, d);
    expect(parts.length).toBe(2);
    expect(parts[0][0]).toBe(c);
    expect(parts[1][1]).toBe(d);
    expect(parts[1][0]).toBe(parts[0][1] + 1);
    for (const [x, y] of parts) expect(y - x).toBeLessThanOrEqual(86_400_000);
  });
});

// Final review I6: stepping back lands on the previous second.
describe('stillIndex', () => {
  const stills = [1000, 2000, 3000];
  it('finds the first still at or after a time going forward, the last at or before going back', () => {
    expect(stillIndex(stills, 1500, 1)).toBe(1);
    expect(stillIndex(stills, 59_999, -1)).toBe(2);
    expect(stillIndex(stills, 2000, -1)).toBe(1);
    expect(stillIndex(stills, 5000, 1)).toBe(2);
    expect(stillIndex(stills, 0, -1)).toBe(0);
  });
});

// Final review I7: the view can be reloaded and linked (?cam&date&t).
describe('timeline cursor', () => {
  it('reads and writes cam, date and the open still', () => {
    expect(timelineCursor(new URLSearchParams('cam=den&date=2026-09-27&t=1790538436000'), '2026-09-28')).toEqual({ cam: 'den', date: '2026-09-27', t: 1790538436000 });
    expect(timelineCursor(new URLSearchParams('date=bad&t=x'), '2026-09-28')).toEqual({ cam: null, date: '2026-09-28', t: null });
    expect(cursorSearch({ cam: 'den', date: '2026-09-27', t: null })).toBe('?cam=den&date=2026-09-27');
    expect(cursorSearch({ cam: 'den', date: '2026-09-27', t: 5 })).toBe('?cam=den&date=2026-09-27&t=5');
  });
});

// Plan 7: the Recordings timeline's scrub preview.
describe('previewAt', () => {
  it('finds the sprite tile for a moment, or nothing where there is none', () => {
    const minute = Date.UTC(2026, 8, 27, 19, 3);
    const present = Array(60).fill(true);
    present[30] = false;
    const list = [m(minute, present)];
    expect(previewAt(list, minute + 12_400)).toEqual({ minute: list[0], index: 12 });
    expect(previewAt(list, minute + 30_500)).toBeNull(); // that second has no tile
    expect(previewAt(list, minute + 60_000)).toBeNull(); // no sprite for that minute
  });
});

describe('thumbCoverage (where the timeline has a thumbnail)', () => {
  const day = Date.UTC(2026, 8, 27, 5); // local midnight, 2026-09-27
  const win = { start: 0, end: 7200 }; // 00:00–02:00

  it('covers the proxy’s preview minutes and the events, merged, as percent of the window', () => {
    const previews = [m(day), m(day + 60_000), m(day + 3600_000)];
    const events = [{ start: 90, end: 150 }, { start: 5400, end: 5460 }];
    expect(thumbCoverage(previews, events, day, win)).toEqual([
      { left: 0, width: (150 / 7200) * 100 }, // minutes 0–1 plus an event ending 02:30
      { left: 50, width: (60 / 7200) * 100 },
      { left: 75, width: (60 / 7200) * 100 },
    ]);
  });

  it('clips to the window and is empty without anything', () => {
    expect(thumbCoverage([], [], day, win)).toEqual([]);
    expect(thumbCoverage([], [{ start: 7100, end: 7300 }], day, win)).toEqual([{ left: (7100 / 7200) * 100, width: (100 / 7200) * 100 }]);
  });
});

describe('thumbCoverage with partly filled preview minutes (review M7)', () => {
  it('covers only the seconds that have a tile', () => {
    const day = Date.UTC(2026, 8, 27, 5);
    const present = Array(60).fill(false).map((_, i) => i < 10 || i >= 50);
    expect(thumbCoverage([m(day, present)], [], day, { start: 0, end: 60 })).toEqual([
      { left: 0, width: (10 / 60) * 100 },
      { left: (50 / 60) * 100, width: (10 / 60) * 100 },
    ]);
  });
});

describe('the minute view (spec 2026-09-30-analytics-in-cams-design)', () => {
  const M = Date.UTC(2026, 8, 30, 20, 48); // a minute
  const iso = (ms: number) => new Date(ms).toISOString();
  const minute = { minute: M, intervalS: 1, present: Array(60).fill(true) as boolean[] };
  const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
  const card = (s: number, e: number, triggers: string[], stills: { eventId: number; stillTs: number; n: number }[] = []) => ({
    id: String(s), start: iso(s), end: iso(e), triggers,
    analysis: stills.length ? { stills: stills.map((x) => ({ eventId: x.eventId, stillTs: x.stillTs, summary: Array(x.n).fill({ category: 'person', subtype: 'person', score: 0.8, box }) })) } : undefined,
  });

  it('steps to the neighbouring minute of the same hour only', () => {
    const hour = [{ minute: M }, { minute: M + 60_000 }];
    expect(stepMinute(hour, M, 1)).toBe(M + 60_000);
    expect(stepMinute(hour, M + 60_000, 1)).toBeNull();
    expect(stepMinute(hour, M, -1)).toBeNull();
  });

  it('lists the cards that overlap a minute, by start', () => {
    const a = card(M + 30_000, M + 90_000, ['motion']);
    const b = card(M - 30_000, M + 5000, ['person']);
    const c = card(M + 61_000, M + 70_000, ['pet']);
    expect(cardsInMinute(minute, [a, b, c])).toEqual([b, a]);
  });

  it('colours a card by its most specific trigger', () => {
    expect(cardKind({ triggers: ['motion', 'person'] })).toBe('person');
    expect(cardKind({ triggers: [] })).toBe('motion');
  });

  it('colours a minute by the most specific kind among its cards, not the earliest', () => {
    const cards = [card(M, M + 5000, ['motion']), card(M + 20_000, M + 25_000, ['person'])];
    expect(minuteKind(minute, cards)).toBe('person');
    expect(minuteKind(minute, [])).toBeNull();
  });

  it('colours each second by the most specific card covering it', () => {
    const k = secondKinds(minute, [card(M, M + 10_000, ['motion']), card(M + 5000, M + 7000, ['vehicle'])]);
    expect(k[0]).toBe('motion');
    expect(k[6]).toBe('vehicle');
    expect(k[20]).toBeNull();
  });

  it('marks a minute with its card count and with a still that found something', () => {
    const found = card(M, M + 30_000, ['person'], [{ eventId: 1, stillTs: M + 20_000, n: 1 }]);
    const nothing = card(M + 40_000, M + 50_000, ['person'], [{ eventId: 2, stillTs: M + 41_000, n: 0 }]);
    expect(minuteMarks(minute, [found, nothing])).toEqual({ count: 2, analysed: true });
    expect(minuteMarks(minute, [nothing])).toEqual({ count: 1, analysed: false });
    expect(minuteMarks({ minute: M + 60_000 }, [found])).toEqual({ count: 0, analysed: false }); // the still's minute only
  });

  it('does not count a card that ends exactly where the minute starts (issue #109)', () => {
    const before = card(M - 30_000, M, ['person']);
    expect(cardsInMinute(minute, [before])).toEqual([]);
    expect(cardsInMinute({ minute: M - 60_000 }, [before])).toEqual([before]);
  });

  it('works on seconds of two: one tile per two seconds (issue #109)', () => {
    const two = { minute: M, intervalS: 2, present: Array(30).fill(true) as boolean[] };
    const k = secondKinds(two, [card(M + 4000, M + 5000, ['pet'])]);
    expect(k[1]).toBeNull();
    expect(k[2]).toBe('pet');
    expect(k[3]).toBeNull();
    const s = analysedSeconds(two, [card(M, M + 30_000, ['person'], [{ eventId: 7, stillTs: M + 21_000, n: 1 }])]);
    expect(s[10]).toMatchObject({ stillTs: M + 21_000 }); // 20-21 s
    expect(s.filter((x) => x !== null)).toHaveLength(1);
    expect(tileIndex({ ...m(M), intervalS: 2 }, M + 21_000)).toBe(10);
  });

  it('indexes the day once: per minute its cards, count, kind and Vision mark (issue #109)', () => {
    const cards = [
      card(M - 30_000, M + 5000, ['motion']),
      card(M + 20_000, M + 70_000, ['person'], [{ eventId: 1, stillTs: M + 65_000, n: 1 }]),
      card(M + 61_000, M + 62_000, ['pet'], [{ eventId: 2, stillTs: M + 61_500, n: 0 }]),
    ];
    const idx = minuteIndex([{ minute: M - 60_000 }, { minute: M }, { minute: M + 60_000 }, { minute: M + 120_000 }], cards);
    for (const x of [M - 60_000, M, M + 60_000, M + 120_000]) {
      const one = { minute: x };
      expect(idx.get(x)).toEqual({ cards: cardsInMinute(one, cards), kind: minuteKind(one, cards), ...minuteMarks(one, cards) });
    }
    expect(idx.get(M + 60_000)).toMatchObject({ count: 2, kind: 'person', analysed: true });
  });

  it('finds the analysed still of each second', () => {
    const s = analysedSeconds(minute, [card(M, M + 30_000, ['person'], [{ eventId: 7, stillTs: M + 20_000, n: 1 }])]);
    expect(s[20]).toMatchObject({ eventId: 7, stillTs: M + 20_000 });
    expect(s.filter((x) => x !== null)).toHaveLength(1);
  });
});

