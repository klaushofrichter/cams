// The Save dialog's length rule (Klaus, 2026-10-04): the same table as
// cam-proxy's (test/compose-plan.test.ts there, compositionWindow), so the
// dialog, cams's server and the proxy never disagree. A 114 s recording; a
// number is the result in seconds, a string the refusal.
import { describe, expect, it } from 'vitest';
import { formatSeconds, GENERATE_MAX_S, GENERATE_MAX_S_1080P, generateMaxS, isPlain, PLAIN_MAX_S, resultLength, saveMaxS } from '../server/clipLimits';

const C = 114;
const LENGTH_CASES: [string, number, number, number, number | string][] = [
  ['the clip alone', 0, 0, GENERATE_MAX_S, 114],
  ['image 16: cut 100 s at the start, 30 s after', -100, 30, GENERATE_MAX_S, 44],
  ['cut at the end', 0, -14, GENERATE_MAX_S, 100],
  ['cut at the start', -14, 0, GENERATE_MAX_S, 100],
  ['pre-roll into the neighbour clip and the gap, up to the limit', 186, 0, GENERATE_MAX_S, 300],
  ['one second over the limit', 187, 0, GENERATE_MAX_S, 'At most 300 s (5:00)'],
  ['both rolls to the limit', 10, 176, GENERATE_MAX_S, 300],
  ['1 s left', -113, 0, GENERATE_MAX_S, 1],
  ['nothing left', -114, 0, GENERATE_MAX_S, 'At least 1 s of the clip must remain'],
  ['1 s left between two cuts', -60, -53, GENERATE_MAX_S, 1],
  ['the cuts cross', -60, -54, GENERATE_MAX_S, 'At least 1 s of the clip must remain'],
  ['a cut at the end past the start', 0, -200, GENERATE_MAX_S, 'At least 1 s of the clip must remain'],
  ['a pre-roll with the clip cut to its first second', 50, -113, GENERATE_MAX_S, 51],
  ['1080p: the clip alone', 0, 0, GENERATE_MAX_S_1080P, 114],
  ['1080p: over its limit', 0, 7, GENERATE_MAX_S_1080P, 'At most 120 s (2:00)'],
  ['not whole seconds', 1.5, 0, GENERATE_MAX_S, 'Whole seconds from -3600 to 3600'],
];

describe('resultLength', () => {
  it.each(LENGTH_CASES)('%s (pre %d, post %d, at most %d)', (_name, preS, postS, maxS, want) => {
    expect(resultLength(C, preS, postS, maxS)).toEqual(typeof want === 'number' ? { ok: true, seconds: want } : { ok: false, error: want });
  });
});

describe('the limits', () => {
  it('a plain save (SD or 4K as recorded) is up to 600 s, a generated one 300 s, 120 s at 1080p', () => {
    expect([PLAIN_MAX_S, GENERATE_MAX_S, GENERATE_MAX_S_1080P]).toEqual([600, 300, 120]);
    expect(isPlain('sd', 0, 0)).toBe(true);
    expect(isPlain('4k', 0, 0)).toBe(true);
    expect(isPlain('sd', 0, -1)).toBe(false);
    expect(isPlain('720p', 0, 0)).toBe(false);
    expect(saveMaxS('sd', 0, 0)).toBe(600);
    expect(saveMaxS('4k', 0, 0)).toBe(600);
    expect(saveMaxS('sd', -100, 30)).toBe(300);
    expect(saveMaxS('360p', 0, 0)).toBe(300);
    expect(saveMaxS('1080p', 0, 0)).toBe(120);
    expect(generateMaxS('720p')).toBe(300);
  });
});

describe('formatSeconds', () => {
  it.each([[0, '0 s'], [44, '44 s'], [59, '59 s'], [60, '60 s (1:00)'], [114, '114 s (1:54)'], [300, '300 s (5:00)'], [600, '600 s (10:00)'], [3725, '3725 s (62:05)']])('%d → %s', (n, text) => {
    expect(formatSeconds(n)).toBe(text);
  });
});
