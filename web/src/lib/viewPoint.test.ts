// @vitest-environment jsdom
//
// Klaus, 2026-09-29: the Timeline shares the cursor with History (and Live).
import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { historySeek, loadViewPoint, nearestMinute, openHistory, saveViewPoint, type PreviewMinute } from './timeline';
import { loadCursor, localDate } from './recordings';

afterEach(() => sessionStorage.clear());

const m = (minute: number) => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: [], url: '' }) as unknown as PreviewMinute;

describe('the shared view point', () => {
  it('remembers a History time or "now" (Live), per camera', () => {
    expect(loadViewPoint('den')).toBeUndefined();
    saveViewPoint('den', 1_790_000_123_000);
    expect(loadViewPoint('den')).toEqual({ at: 1_790_000_123_000 });
    expect(loadViewPoint('barn')).toBeUndefined(); // another camera
    saveViewPoint('den', null);
    expect(loadViewPoint('den')).toEqual({ at: null }); // Live: now
  });

  it('ignores anything unreadable', () => {
    sessionStorage.setItem('cams.viewPoint', '{"cam":"den","at":"x"}');
    expect(loadViewPoint('den')).toBeUndefined();
    sessionStorage.setItem('cams.viewPoint', 'nope');
    expect(loadViewPoint('den')).toBeUndefined();
  });
});

describe('nearestMinute', () => {
  const list = [m(0), m(60_000), m(180_000)]; // 00:00, 00:01, 00:03 (00:02 has no sprite)
  it('is the minute holding the time, else the nearest one', () => {
    expect(nearestMinute(list, 75_000)!.minute).toBe(60_000);
    expect(nearestMinute(list, 150_000)!.minute).toBe(180_000); // 00:02:30: 00:03 is nearer than 00:01
    expect(nearestMinute(list, 125_000)!.minute).toBe(60_000); // 00:02:05: 00:01's end is nearer
    expect(nearestMinute(list, 10_000_000)!.minute).toBe(180_000); // later than all: the newest (Live)
    expect(nearestMinute([], 0)).toBeNull();
  });
});

// Review fix: History already at that second and playing must still stop
// there, and the URL alone can't say so (it may not even change).
describe('openHistory', () => {
  it('saves the shared cursor, goes to History at the second and asks it to stop there', () => {
    history.replaceState(null, '', '/app/recordings?cam=den&panel=history&at=5000');
    openHistory('den', 5000);
    expect(location.pathname + location.search).toBe('/app/recordings?cam=den&panel=history&at=5000');
    expect(loadViewPoint('den')).toEqual({ at: 5000 });
    expect(loadCursor()?.cursor.at).toBe(5000);
    expect(loadCursor()?.cursor.date).toBe(localDate(new Date(5000)));
    expect(get(historySeek)).toEqual({ cam: 'den', at: 5000 });
    historySeek.set(null);
  });
});
