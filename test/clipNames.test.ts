import { describe, expect, it } from 'vitest';
import {
  clipIdOf,
  clipTimes,
  CLIP_ID,
  decodeTriggers,
  isRealDate,
  isRealMonth,
  parseClipName,
  timeInfoFromGetTime,
} from '../server/recordings/clipNames';

const SUB = '/mnt/sda/Mp4Record/2026-09-25/RecS0A_DST20260925_125653_125718_0_55148080000000_927C9.mp4';
const MAIN = '/mnt/sda/Mp4Record/2026-09-25/RecM0A_DST20260925_121100_121119_0_7B288280000000_10BF000.mp4';
const CHICAGO = timeInfoFromGetTime({
  Time: { timeZone: 21600, isDst: 1 },
  Dst: { enable: 1, offset: 1 },
});

describe('decodeTriggers (name version 10, 14 hex digits)', () => {
  it.each([
    ['55148080000000', ['motion']],
    ['7B288280000000', ['motion']],
    ['5514C000000000', ['person']],
    ['55149000000000', ['vehicle']],
    ['55148800000000', ['pet']],
  ])('%s -> %j', (hex, triggers) => {
    expect(decodeTriggers(hex)).toEqual(triggers);
  });

  it('decodes several triggers at once, in a stable order', () => {
    // person + vehicle + motion
    expect(decodeTriggers('5514D080000000')).toEqual(['person', 'vehicle', 'motion']);
  });

  it('returns no triggers for flag fields of an unknown length', () => {
    expect(decodeTriggers('6D28808')).toEqual([]);
  });
});

describe('parseClipName', () => {
  it('parses a real sub-stream name', () => {
    expect(parseClipName(SUB)).toEqual({
      name: SUB,
      stream: 'sub',
      date: '2026-09-25',
      start: '125653',
      end: '125718',
      dst: true,
      triggers: ['motion'],
    });
  });

  it('parses a real main-stream name', () => {
    expect(parseClipName(MAIN)).toMatchObject({ stream: 'main', start: '121100', end: '121119', triggers: ['motion'] });
  });

  it('parses a name without the DST flag and without the animal-type field', () => {
    const p = parseClipName('Mp4Record/2026-01-10/RecS0A_20260110_080000_080030_55148080000000_927C9.mp4');
    expect(p).toMatchObject({ date: '2026-01-10', dst: false, start: '080000', end: '080030' });
  });

  it.each(['', 'foo.mp4', '/etc/passwd', 'RecX0A_20260925_125653_125718_0_55148080000000_927C9.mp4', 'RecS0A_20260925_1256_125718_0_5514_9.mp4'])(
    'rejects %j',
    (name) => expect(parseClipName(name)).toBeNull(),
  );
});

describe('clip ids', () => {
  it('derive from camera-local date and times', () => {
    expect(clipIdOf(parseClipName(SUB)!)).toBe('20260925-125653-125718');
    expect(CLIP_ID.test('20260925-125653-125718')).toBe(true);
  });

  it.each(['../etc', '20260925-125653', '20260925-125653-125718/..', '2026-09-25-125653-125718', '20260925%2F125653-125718'])(
    'rejects %j',
    (id) => expect(CLIP_ID.test(id)).toBe(false),
  );
});

describe('clipTimes', () => {
  it('uses the DST flag from the name for the offset', () => {
    expect(clipTimes(parseClipName(SUB)!, CHICAGO)).toEqual({
      start: '2026-09-25T12:56:53-05:00',
      end: '2026-09-25T12:57:18-05:00',
      durationSec: 25,
    });
  });

  it('uses standard time when the name has no DST flag', () => {
    const p = parseClipName('Mp4Record/2026-01-10/RecS0A_20260110_080000_080030_55148080000000_927C9.mp4')!;
    expect(clipTimes(p, CHICAGO).start).toBe('2026-01-10T08:00:00-06:00');
  });

  // Review focus 3: a clip running across midnight.
  it('rolls the end over to the next day when it is earlier than the start', () => {
    const p = parseClipName('Mp4Record/2026-09-25/RecS0A_DST20260925_235950_000020_0_55148080000000_927C9.mp4')!;
    expect(clipTimes(p, CHICAGO)).toEqual({
      start: '2026-09-25T23:59:50-05:00',
      end: '2026-09-26T00:00:20-05:00',
      durationSec: 30,
    });
  });

  it('reads GetTime into offsets', () => {
    expect(CHICAGO).toEqual({ stdOffsetMinutes: -360, dstOffsetMinutes: 60 });
    expect(timeInfoFromGetTime({ Time: { timeZone: -3600 }, Dst: { enable: 0, offset: 1 } })).toEqual({
      stdOffsetMinutes: 60,
      dstOffsetMinutes: 0,
    });
  });
});

// Fix round 1, item 10: the regex alone lets calendar nonsense through.
describe('isRealDate', () => {
  it('accepts real calendar dates', () => {
    expect(isRealDate('2026-09-25')).toBe(true);
    expect(isRealDate('2024-02-29')).toBe(true); // leap year
  });

  it('rejects a well-formed but non-existent date', () => {
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2023-02-29')).toBe(false); // not a leap year
  });

  it('rejects anything not matching the shape at all', () => {
    expect(isRealDate('2026-9-1')).toBe(false);
    expect(isRealDate('')).toBe(false);
  });
});

describe('isRealMonth', () => {
  it('accepts real months', () => {
    expect(isRealMonth('2026-01')).toBe(true);
    expect(isRealMonth('2026-12')).toBe(true);
  });

  it('rejects a well-formed but out-of-range month', () => {
    expect(isRealMonth('2026-13')).toBe(false);
    expect(isRealMonth('2026-00')).toBe(false);
  });

  it('rejects anything not matching the shape at all', () => {
    expect(isRealMonth('202609')).toBe(false);
    expect(isRealMonth('')).toBe(false);
  });
});
