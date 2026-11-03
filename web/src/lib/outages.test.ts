import { describe, expect, it, vi } from 'vitest';
import { blankTexts, createOutages, NO_STILL, outageText, walkBlank, type Outage } from './outages';
import { localClock } from './clock';

const T = Date.parse('2026-11-03T09:39:00-06:00');
const MIN = 60_000;
const hm = (t: number) => localClock(t, false);

describe('outageText', () => {
  it('no outage, an unknown cause, or none overlapping: the plain sentence', () => {
    expect(outageText([], T, T + MIN)).toBe(NO_STILL);
    expect(outageText([{ cause: 'meteor', from: T, to: T + MIN }], T, T + MIN)).toBe(NO_STILL);
    expect(outageText([{ cause: 'offline', from: T + 2 * MIN, to: T + 3 * MIN }], T, T + MIN)).toBe(NO_STILL);
    expect(outageText([{ cause: 'offline', from: T - 3 * MIN, to: T - MIN }], T, T + MIN)).toBe(NO_STILL);
  });

  it('names each reason with its time: a span, a moment, an open one', () => {
    const list: Outage[] = [
      { cause: 'offline', from: T, to: T + 2 * MIN },
      { cause: 'address', from: T + 2 * MIN, to: T + 2 * MIN },
    ];
    expect(outageText(list, T, T + 3 * MIN)).toBe(`Camera was offline (${hm(T)}–${hm(T + 2 * MIN)}); Camera address changed (${hm(T + 2 * MIN)})`);
    expect(outageText([{ cause: 'paused', from: T, to: null }], T + MIN, T + 2 * MIN)).toBe(`Proxy storage was full (since ${hm(T)})`);
  });

  it('has words for every cause cam-proxy sends; at most three reasons, no repeats', () => {
    const causes = ['offline', 'reboot', 'powercycle', 'address', 'stop', 'crash', 'paused'];
    const words = causes.map((cause) => outageText([{ cause, from: T, to: T }], T, T + 1));
    expect(words.every((w) => w !== NO_STILL)).toBe(true);
    expect(words.map((w) => w.replace(/ \([^()]*\)$/, ''))).toEqual(['Camera was offline', 'Camera restarted', 'Camera power cycled (PoE)', 'Camera address changed', 'Proxy was stopped', 'Proxy restarted after a crash', 'Proxy storage was full']);
    const many = causes.map((cause) => ({ cause, from: T, to: T + 1 }));
    expect(outageText([...many, many[0]], T, T + 1).split('; ')).toHaveLength(3);
  });
});

describe('blankTexts', () => {
  const slot = (i: number, blank: boolean) => ({ t: T + i * 1000, blank });
  it('gives every slot of a blank run the text of the whole run', () => {
    const slots = [slot(0, false), slot(1, true), slot(2, true), slot(3, false), slot(4, true)];
    const list = [{ cause: 'offline', from: T + 2500, to: T + 3000 }]; // inside slot 2 only
    const m = blankTexts(slots, 1000, list);
    expect(m.has(T)).toBe(false);
    expect(m.get(T + 1000)).toMatch(/^Camera was offline/);
    expect(m.get(T + 2000)).toMatch(/^Camera was offline/);
    expect(m.get(T + 4000)).toBe(NO_STILL);
  });
  it('extends the first and last runs past the row', () => {
    const slots = [slot(0, true), slot(1, false), slot(2, true)];
    const list = [{ cause: 'reboot', from: T - 30_000, to: T - 20_000 }, { cause: 'crash', from: T + 40_000, to: T + 40_000 }];
    const m = blankTexts(slots, 1000, list, { before: (a) => a - 60_000, after: (b) => b + 60_000 });
    expect(m.get(T)).toMatch(/^Camera restarted/);
    expect(m.get(T + 2000)).toMatch(/^Proxy restarted after a crash/);
  });
});

describe('walkBlank', () => {
  it('walks while blank, both ways, and stops after max steps', () => {
    const blank = (t: number) => t >= T - 5000 && t < T + 7000;
    expect(walkBlank(T, -1000, blank)).toBe(T - 5000);
    expect(walkBlank(T, 1000, blank)).toBe(T + 7000);
    expect(walkBlank(T, 1000, () => true, 10)).toBe(T + 10_000);
  });
});

describe('createOutages', () => {
  it('asks once per 6-hour block, merges the blocks, and counts a failure as none', async () => {
    const urls: string[] = [];
    const o1: Outage = { cause: 'offline', from: T, to: T + MIN };
    const fetch = vi.fn(async <R>(url: string): Promise<R> => {
      urls.push(url);
      if (urls.length === 2) throw new Error('down');
      return { outages: [o1] } as R;
    });
    const changed = vi.fn();
    const o = createOutages('back yard', fetch, changed);
    o.ensure(T - 7 * 3_600_000, T); // two blocks
    o.ensure(T - 7 * 3_600_000, T); // in flight: not again
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/^\/api\/cameras\/back%20yard\/outages\?from=\d+&to=\d+$/);
    expect(o.get(-Infinity, Infinity)).toEqual([o1]); // the same outage once
    expect(o.get(T + 2 * MIN, T + 3 * MIN)).toEqual([]);
    o.destroy();
  });
});
