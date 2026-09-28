// web/src/components/Strip.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Strip from './Strip.svelte';
import { preferences, type Preferences } from '../lib/preferences';
import type { Coverage } from '../lib/strip';
import type { EventClip } from '../lib/recordings';

const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 1, liveKeepAlive: 60 };
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
    expect(kinds).toEqual(['none', 'pictures', 'none', 'outside']);
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

  it('a click on a drawn event goes to its start, even where the drawing is wider than the clip', () => {
    const onseek = vi.fn();
    const short = ev('20260927-121000-121005', T + 10 * 60_000, 5); // 5 s: drawn at the 0.3 % minimum width
    preferences.set({ ...PREFS, timelineZoom: 24 });
    const bar = render({ onseek, events: [short] });
    preferences.set({ ...PREFS, timelineZoom: 24 });
    flushSync();
    const seg = target!.querySelector('[data-testid="timeline-seg"]') as HTMLElement;
    const left = parseFloat(seg.style.left);
    const width = parseFloat(seg.style.width);
    const x = ((left + width * 0.9) / 100) * 600; // near the drawn end, past the clip's real end
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: x, bubbles: true }));
    expect(onseek).toHaveBeenCalledWith(Date.parse(short.start));
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

  it('puts ticks on local hours, with the date at midnight, at 24 h (review #10)', () => {
    preferences.set({ ...PREFS, timelineZoom: 24 });
    render({ coverage: { clips: [], stills: [], previews: [] } });
    preferences.set({ ...PREFS, timelineZoom: 24 });
    flushSync();
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels).toContain('03:00');
    expect(labels).toContain('Mon 28');
    expect(labels).not.toContain('01:00');
  });

  it('ends a drag when the browser cancels the pointer (review #11)', () => {
    const ondrag = vi.fn();
    const bar = render({ ondrag });
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointermove', { clientX: 320, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointercancel', { clientX: 320, bubbles: true }));
    expect(ondrag).toHaveBeenLastCalledWith(false);
  });

  it('a click inside a long event keeps the time under the pointer (review #13)', () => {
    const onseek = vi.fn();
    const long = ev('20260927-115000-121000', T - 10 * 60_000, 20 * 60); // 11:50–12:10
    const bar = render({ onseek, events: [long] });
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 350, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: 350, bubbles: true }));
    expect(onseek).toHaveBeenCalledWith(T + 5 * 60_000);
  });

  it('has buttons to the oldest content, one window back and forward, and now (Klaus, 2026-09-28)', () => {
    const onseek = vi.fn();
    const oldest = T - 5 * 3_600_000;
    render({ onseek, oldest, now: T + 1_800_000 }); // 1 h window
    q('strip-back')!.click();
    expect(onseek).toHaveBeenLastCalledWith(T - 3_600_000);
    q('strip-forward')!.click();
    expect(onseek).toHaveBeenLastCalledWith(T + 1_800_000 - 2000); // not past now: stops at the edge
    q('strip-oldest')!.click();
    expect(onseek).toHaveBeenLastCalledWith(oldest);
    q('strip-now')!.click();
    expect(onseek).toHaveBeenLastCalledWith(T + 1_800_000 - 2000);
  });

  it('disables the buttons that point past an edge', () => {
    render({ oldest: T, now: T + 2000 });
    expect((q('strip-oldest') as HTMLButtonElement).disabled).toBe(true);
    expect((q('strip-back') as HTMLButtonElement).disabled).toBe(true);
    expect((q('strip-forward') as HTMLButtonElement).disabled).toBe(true);
    expect((q('strip-now') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never seeks past the edges by dragging', () => {
    const onseek = vi.fn();
    const bar = render({ onseek, oldest: T - 60_000, now: T + 60_000 });
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, bubbles: true })); // 30 min later: past now
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, bubbles: true }));
    expect(onseek).toHaveBeenLastCalledWith(T + 60_000 - 2000);
  });

  it('draws stills and preview tiles in one colour: both are pictures (Klaus, 2026-09-28)', () => {
    render({ coverage: { clips: [], stills: [{ start: T - 60_000, end: T }], previews: [{ start: T - 20 * 60_000, end: T }] }, now: T + 1_800_000 });
    const kinds = [...target!.querySelectorAll('[data-testid="strip-span"]')].map((e) => (e as HTMLElement).dataset.kind);
    expect(kinds).toEqual(['none', 'pictures', 'none']);
  });

  it('marks the playhead with a triangle above the bar', () => {
    render({});
    expect(q('strip-playhead-mark')).not.toBeNull();
  });

  it('offers 30 minutes, with ticks every 5 minutes', () => {
    render({});
    preferences.set({ ...PREFS, timelineZoom: 0.5 });
    flushSync();
    expect(q('zoom-0.5')!.textContent).toBe('30 min');
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels).toContain('12:05');
    expect(labels).toContain('11:50');
  });

  it('follows the pointer with a line and the time under it, even without a picture (Klaus, 2026-09-28)', () => {
    const bar = render({});
    bar.dispatchEvent(new PointerEvent('pointermove', { clientX: 150, bubbles: true }));
    flushSync();
    expect(q('strip-cursor')!.style.left).toBe('25%');
    const label = new Date(T - 15 * 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    expect(q('strip-cursor-time')!.textContent).toBe(label);
    bar.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    flushSync();
    expect(q('strip-cursor')).toBeNull();
  });

  it('has a band of small frames under the bar; a frame click seeks to its time', () => {
    const onseek = vi.fn();
    render({ onseek, filmWidth: 600 });
    const frames = [...target!.querySelectorAll('[data-testid="strip-film-frame"]')] as HTMLElement[];
    expect(frames.length).toBe(11); // 600 px / (48 + 3)
    frames[0].click();
    expect(onseek).toHaveBeenCalledTimes(1);
    expect(Number(frames[0].dataset.t)).toBe(onseek.mock.calls[0][0]);
  });
});
