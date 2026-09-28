// web/src/components/Strip.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Strip from './Strip.svelte';
import { preferences, type Preferences } from '../lib/preferences';
import type { Coverage } from '../lib/strip';
import type { EventClip } from '../lib/recordings';

const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 1, liveKeepAlive: 60 };
const T = Date.parse('2026-09-27T12:00:00-05:00');
const ev = (id: string, s: number, sec = 60): EventClip => ({ id, start: new Date(s).toISOString(), end: new Date(s + sec * 1000).toISOString(), durationSec: sec, triggers: ['motion'], sizeSub: 1, sizeMain: 1 });
const cov: Coverage = { clips: [], stills: [{ start: T - 600_000, end: T }], previews: [] };

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  preferences.set(null);
});
function render(props: Record<string, unknown>) {
  preferences.set(PREFS);
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Strip, { target, props: { coverage: cov, events: [], visibleIds: new Set(), failedIds: new Set(), at: T, now: T + 1_800_000, currentId: null, previews: [], onseek: () => undefined, ...props } });
  flushSync();
  const bar = target.querySelector('[data-testid="timeline"]') as HTMLElement;
  bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 46, right: 600, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
  return bar;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('Strip', () => {
  it('centres the playhead and colours the window', () => {
    render({ now: T + 15 * 60_000 });
    expect(q('strip-playhead')!.style.left).toBe('50%');
    const kinds = [...target!.querySelectorAll('[data-testid="strip-span"]')].map((e) => (e as HTMLElement).dataset.kind);
    expect(kinds).toEqual(['none', 'stills', 'none', 'future']);
  });

  it('offers five zooms', () => {
    render({});
    for (const z of [24, 12, 6, 3, 1]) expect(q(`zoom-${z}`)).not.toBeNull();
    expect(q('zoom-1')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('seeks to the time under a click (1 h window: 600 px = 60 min)', () => {
    const onseek = vi.fn();
    const bar = render({ onseek });
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 400, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: 400, bubbles: true }));
    expect(onseek).toHaveBeenCalledWith(T + 10 * 60_000);
  });

  it('drags time under the playhead: right moves back in time', () => {
    const onseek = vi.fn();
    const ondrag = vi.fn();
    const bar = render({ onseek, ondrag });
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointermove', { clientX: 330, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: 330, bubbles: true }));
    expect(ondrag).toHaveBeenNthCalledWith(1, true);
    expect(onseek).toHaveBeenLastCalledWith(T - 3 * 60_000);
    expect(ondrag).toHaveBeenLastCalledWith(false);
  });

  it('scrolls time with a sideways wheel', () => {
    const onseek = vi.fn();
    const bar = render({ onseek });
    bar.dispatchEvent(new WheelEvent('wheel', { deltaX: 60, bubbles: true, cancelable: true }));
    expect(onseek).toHaveBeenCalledWith(T + 6 * 60_000);
  });

  it('dims filtered-out events and marks failed ones', () => {
    const a = ev('20260927-115000-115100', T - 600_000);
    const b = ev('20260927-120500-120600', T + 300_000);
    render({ events: [a, b], visibleIds: new Set([a.id]), failedIds: new Set([b.id]) });
    const segs = [...target!.querySelectorAll('[data-testid="timeline-seg"]')] as HTMLElement[];
    expect(segs.map((s) => [s.dataset.clipId, s.classList.contains('dim'), s.classList.contains('failed')])).toEqual([
      [a.id, false, false],
      [b.id, true, true],
    ]);
  });

  it('labels hours, twice on the 25-hour day, and dates at midnight', () => {
    render({ at: new Date(2026, 10, 1, 1, 30).getTime(), now: new Date(2026, 10, 2).getTime(), coverage: { clips: [], stills: [], previews: [] } });
    preferences.set({ ...PREFS, timelineZoom: 6 });
    flushSync();
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels.filter((l) => l === '01:00')).toHaveLength(2);
    expect(labels).toContain('Sun 1');
  });
});
