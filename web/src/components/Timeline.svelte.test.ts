// @vitest-environment jsdom
//
// Live's mini timeline: a whole day's recordings as one bar. A click picks the
// second under the pointer; ←/→ step between recordings.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Timeline from './Timeline.svelte';
import type { EventClip } from '../lib/recordings';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
});

const date = '2026-09-27';
const ev = (id: string, hhmm: string): EventClip => {
  const start = `${date}T${hhmm}:00-05:00`;
  return { id, start, end: new Date(Date.parse(start) + 30_000).toISOString(), durationSec: 30, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
};

describe('Timeline (Live legend)', () => {
  it('draws the day’s recordings, picks the second under a click and steps with the keys', () => {
    const onpick = vi.fn();
    const onstep = vi.fn();
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target, props: { events: [ev('a', '06:00'), ev('b', '18:00')], date, selectedId: null, onpick, onstep, onedge: () => undefined, compact: true, legend: true, now: 43_200, testid: 'live-timeline' } });
    flushSync();
    expect(target.querySelectorAll('[data-testid="timeline-seg"]')).toHaveLength(2);
    expect(target.querySelector('[data-testid="timeline-now"]')).not.toBeNull();
    const bar = target.querySelector('[data-testid="live-timeline"]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 30, right: 1440, bottom: 30, x: 0, y: 0, toJSON: () => ({}) });
    bar.dispatchEvent(new MouseEvent('click', { clientX: 360, bubbles: true }));
    expect(onpick).toHaveBeenCalledWith(21_600);
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onstep).toHaveBeenCalledWith(1);
  });
});
