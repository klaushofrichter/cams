// @vitest-environment jsdom
//
// Plan 7 review I4: the scrub preview loads a minute's sprite only once the
// pointer rests there (150 ms), so a sweep across the day doesn't fetch
// hundreds of sprites.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Timeline from './Timeline.svelte';
import { dayRange, type PreviewMinute } from '../lib/timeline';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
});

const date = '2026-09-27';
const start = dayRange(date)[0];
const sprite = (minute: number): PreviewMinute => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/sprite/${minute}.jpg` });

describe('Timeline scrub preview', () => {
  it('shows the time at once and the sprite only after the pointer rests', () => {
    vi.useFakeTimers();
    const previews = [sprite(start + 600 * 60_000), sprite(start + 900 * 60_000)];
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target, props: { events: [], date, selectedId: null, onpick: () => undefined, onstep: () => undefined, onedge: () => undefined, previews, dayStartMs: start } });
    flushSync();
    const bar = target.querySelector('[data-testid="timeline"]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 46, right: 1440, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
    const moveTo = (min: number) => bar.dispatchEvent(new MouseEvent('pointermove', { clientX: min, bubbles: true }));
    const frame = () => target!.querySelector('[data-testid="scrub-preview"] .frame') as HTMLElement | null;
    moveTo(600); // minute 600 of the 24 h window (1 px per minute)
    flushSync();
    expect(target.querySelector('[data-testid="scrub-preview"]')).not.toBeNull();
    expect(frame()!.getAttribute('style') ?? '').not.toContain('background-image');
    vi.advanceTimersByTime(100);
    moveTo(900); // moved on before the rest: minute 600's sprite never loads
    flushSync();
    vi.advanceTimersByTime(100);
    flushSync();
    expect(frame()!.getAttribute('style') ?? '').not.toContain('/sprite/');
    vi.advanceTimersByTime(100);
    flushSync();
    expect(frame()!.getAttribute('style')).toContain(`/sprite/${start + 900 * 60_000}.jpg`);
  });
});
