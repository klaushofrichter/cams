// web/src/components/Strip.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Strip from './Strip.svelte';
import { preferences, type Preferences } from '../lib/preferences';
import type { Coverage } from '../lib/strip';
import type { EventClip } from '../lib/recordings';
import type { PreviewMinute } from '../lib/timeline';
import { localClock } from '../lib/clock';

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
  component = mount(Strip, { target, props: { coverage: cov, events: [], visibleIds: new Set<string>(), failedIds: new Set<string>(), at: T, now: T + 1_800_000, currentId: null, previews: [], onseek: () => undefined, ...props } });
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

  // Klaus, 2026-10-04: no 12 h; 10 min and 1 min added.
  it('offers seven zooms, 24 h down to 1 min', () => {
    render({});
    const zooms = [...target!.querySelectorAll('[data-testid^="zoom-"]')];
    expect(zooms.map((b) => b.getAttribute('data-testid'))).toEqual(['zoom-24', 'zoom-6', 'zoom-3', 'zoom-1', 'zoom-30m', 'zoom-10m', 'zoom-1m']);
    expect(zooms.map((b) => b.textContent)).toEqual(['24 h', '6 h', '3 h', '1 h', '30 min', '10 min', '1 min']);
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
    expect(q('zoom-30m')!.textContent).toBe('30 min');
    q('zoom-30m')!.click();
    flushSync();
    expect(q('strip-back')!.title).toBe('Back 30 min'); // issue #69: not "0.5 h"
    expect(q('strip-forward')!.getAttribute('aria-label')).toBe('Forward 30 minutes');
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels).toContain('12:05');
    expect(labels).toContain('11:50');
  });

  it('offers 10 minutes, with ticks every 2 minutes', () => {
    render({});
    q('zoom-10m')!.click();
    flushSync();
    expect(q('zoom-10m')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('strip-back')!.title).toBe('Back 10 min');
    expect(q('strip-forward')!.getAttribute('aria-label')).toBe('Forward 10 minutes');
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels).toEqual(['11:56', '11:58', '12:00', '12:02', '12:04']);
  });

  it('offers 1 minute, with ticks every 15 seconds that show the seconds', () => {
    render({ barWidth: 640 });
    q('zoom-1m')!.click();
    flushSync();
    expect(q('strip-back')!.title).toBe('Back 1 min');
    expect(q('strip-forward')!.getAttribute('aria-label')).toBe('Forward 1 minute');
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels).toEqual(['11:59:30', '11:59:45', '12:00:00', '12:00:15', '12:00:30']);
    // the edge labels stay inside the bar
    const ticks = [...target!.querySelectorAll('[data-testid="strip-tick"]')];
    expect(ticks[0].classList.contains('start')).toBe(true);
    expect(ticks.at(-1)!.classList.contains('end')).toBe(true);
  });

  it('spaces the ticks for the bar\'s width: every 30 s at 1 min on a phone', () => {
    render({ barWidth: 229 });
    q('zoom-1m')!.click();
    flushSync();
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels).toEqual(['11:59:30', '12:00:00', '12:00:30']);
  });

  it('drags 1 minute across the bar at the 1 min zoom (600 px = 60 s)', () => {
    const onseek = vi.fn();
    const bar = render({ onseek });
    q('zoom-1m')!.click();
    flushSync();
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, bubbles: true }));
    expect(onseek).toHaveBeenLastCalledWith(T + 10_000); // 100 px left: 10 s later
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
    expect(frames.length).toBe(11); // 600 px / (48 + 4)
    frames[0].click();
    expect(onseek).toHaveBeenCalledTimes(1);
    expect(Number(frames[0].dataset.t)).toBe(onseek.mock.calls[0][0]);
  });

  // Klaus, 2026-10-04: the popup over the bar says what the clip is (an icon
  // per type, person, vehicle, pet, motion), "Still" over the stills, and is
  // the same size either way.
  describe('the hover popup', () => {
    // 1 h window, 600 px: 10 px a minute, the playhead (T) at 300.
    const clipAt = T - 10 * 60_000; // x 200 to 210
    const minute = T - 5 * 60_000; // x 250 to 260: a preview minute (stills)
    const pm: PreviewMinute = { minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: '/p.jpg' };
    const clip = (triggers: EventClip['triggers'], counts?: EventClip['counts']): EventClip => ({ ...ev('c1', clipAt), triggers, counts });
    const hoverX = async (bar: HTMLElement, x: number) => {
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: x, bubbles: true }));
      flushSync();
      await vi.advanceTimersByTimeAsync(200); // the 150 ms rest
      flushSync();
    };
    const kinds = () => [...target!.querySelectorAll('[data-testid="scrub-kind"]')].map((e) => (e as HTMLElement).dataset.kind);
    afterEach(() => vi.useRealTimers());

    it('shows an icon per type of the clip, in the cards’ order (motion, person, vehicle, pet), named', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const bar = render({ events: [clip(['motion', 'pet', 'person', 'vehicle'])], thumbFor: (id: string) => `/t/${id}.jpg` });
      await hoverX(bar, 205);
      expect(q('scrub-preview')).not.toBeNull();
      expect(kinds()).toEqual(['motion', 'person', 'vehicle', 'pet']);
      const icons = [...target!.querySelectorAll('[data-testid="scrub-kind"]')] as HTMLElement[];
      expect(icons.map((e) => e.getAttribute('aria-label'))).toEqual(['Motion', 'Person', 'Vehicle', 'Pet']);
      expect(icons.map((e) => e.getAttribute('title'))).toEqual(['Motion', 'Person', 'Vehicle', 'Pet']);
      expect(icons.every((e) => e.querySelector('svg path'))).toBe(true);
    });

    it('counts two or more events of an AI type: "2x"', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const bar = render({ events: [clip(['person', 'motion'], { person: 2 })], thumbFor: (id: string) => `/t/${id}.jpg` });
      await hoverX(bar, 205);
      expect(kinds()).toEqual(['motion', 'person']);
      const person = target!.querySelector('[data-testid="scrub-kind"][data-kind="person"]') as HTMLElement;
      expect(person.textContent!.trim()).toBe('2x');
      expect(person.getAttribute('aria-label')).toBe('Person 2x');
    });

    // Review of #183: a clip without a type the popup draws (a scheduled
    // recording) gets a neutral clip icon, so the slot doesn't look empty.
    it('gives a scheduled-only clip a neutral clip icon in the same slot', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const bar = render({ events: [clip(['timer'])], thumbFor: (id: string) => `/t/${id}.jpg` });
      await hoverX(bar, 205);
      expect(kinds()).toEqual(['clip']);
      const k = target!.querySelector('[data-testid="scrub-kind"]') as HTMLElement;
      expect(k.getAttribute('aria-label')).toBe('Scheduled');
      expect(k.querySelector('svg path')).not.toBeNull();
    });

    it('says Still over the stills, in the same slot, and the box is the same size', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const bar = render({ events: [clip(['person'])], previews: [pm], thumbFor: (id: string) => `/t/${id}.jpg` });
      await hoverX(bar, 205);
      const overClip = q('scrub-preview')!;
      const clipFrame = (q('scrub-frame') as HTMLElement).getAttribute('style');
      expect(kinds()).toEqual(['person']);
      expect(q('scrub-kinds')).not.toBeNull();
      await hoverX(bar, 255);
      expect(kinds()).toEqual(['still']);
      const still = target!.querySelector('[data-testid="scrub-kind"]') as HTMLElement;
      expect(still.getAttribute('aria-label')).toBe('Still');
      expect(still.querySelector('svg path')).not.toBeNull();
      // One box: the frame the same fixed size, the kinds slot, the time.
      expect((q('scrub-frame') as HTMLElement).getAttribute('style')).toBe(clipFrame);
      expect(clipFrame).toMatch(/width: ?160px/);
      expect(clipFrame).toMatch(/height: ?90px/);
      expect(q('scrub-preview')!.children.length).toBe(overClip.children.length);
      expect(q('scrub-preview')!.classList.contains('scrub')).toBe(true);
    });
  });


  // Klaus, 2026-10-04: with the pointer resting on the bar and time moving
  // under it (playback, live), the popup follows: its time at once, its
  // picture at most once a second; not after the pointer left, nor in a
  // hidden tab.
  describe('the popup over a moving window', () => {
    const minute = T - 5 * 60_000;
    const pm: PreviewMinute = { minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: '/p.jpg' };
    // Pointer at 255 px: 45 px left of the playhead, 270 s before `at` (1 h, 600 px).
    const X = 255;
    function renderMoving() {
      const props = $state({ coverage: cov, events: [] as EventClip[], visibleIds: new Set<string>(), failedIds: new Set<string>(), at: T, now: T + 1_800_000, currentId: null, previews: [pm], onseek: () => undefined });
      preferences.set(PREFS);
      target = document.createElement('div');
      document.body.appendChild(target);
      component = mount(Strip, { target, props });
      flushSync();
      const bar = target.querySelector('[data-testid="timeline"]') as HTMLElement;
      bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 46, right: 600, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
      return { bar, props };
    }
    const tick = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      flushSync();
    };
    const when = () => target!.querySelector('[data-testid="scrub-preview"] [data-testid="strip-cursor-time"]')?.textContent;
    const pos = () => (q('scrub-frame')!.querySelector('.frame') as HTMLElement | null)?.style.backgroundPosition;
    const px = (n: number) => (n ? `-${n}px` : '0px');
    const posOf = (i: number) => `${px((i % 10) * 160)} ${px(Math.floor(i / 10) * 90)}`;
    afterEach(() => {
      vi.useRealTimers();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    });

    it('follows the window: the time at once, the picture within a second', async () => {
      vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { bar, props } = renderMoving();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X, bubbles: true }));
      flushSync();
      await tick(200);
      expect(when()).toBe(localClock(T - 270_000));
      expect(pos()).toBe(posOf(30));
      await tick(1000);
      props.at = T + 2000; // the window moved two seconds; the pointer didn't
      flushSync();
      expect(when()).toBe(localClock(T - 268_000));
      expect(pos()).toBe(posOf(32)); // a second since the last picture: at once
      expect(q('strip-cursor')).not.toBeNull();
    });

    it('changes the picture at most once a second, the time every step', async () => {
      vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { bar, props } = renderMoving();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X, bubbles: true }));
      flushSync();
      await tick(200);
      const pictures: string[] = [pos()!];
      for (let k = 1; k <= 12; k++) { // three seconds of playback, 250 ms a step
        props.at = T + k * 250;
        flushSync();
        expect(when()).toBe(localClock(T - 270_000 + k * 250));
        await tick(250);
        if (pos() !== pictures.at(-1)) pictures.push(pos()!);
      }
      expect(pictures.length - 1).toBeLessThanOrEqual(3);
      expect(pictures.length - 1).toBeGreaterThanOrEqual(2);
      expect(pictures.at(-1)).toBe(posOf(33)); // where the pointer is now (T - 267 s)
    });

    it('moves from one clip to the next: its types and its thumbnail', async () => {
      vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { bar, props } = renderMoving();
      props.previews = [];
      const a: EventClip = { ...ev('a', T - 272_000, 4), triggers: ['person'] };
      const b: EventClip = { ...ev('b', T - 268_000, 4), triggers: ['vehicle', 'motion'] };
      props.events = [a, b];
      (props as Record<string, unknown>).thumbFor = (id: string) => `/t/${id}.jpg`;
      flushSync();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X, bubbles: true })); // T - 270 s: clip a
      flushSync();
      await tick(1200);
      const img = () => q('scrub-frame')!.querySelector('img')?.getAttribute('src');
      const kinds = () => [...target!.querySelectorAll('[data-testid="scrub-kind"]')].map((e) => (e as HTMLElement).dataset.kind);
      expect(img()).toBe('/t/a.jpg');
      expect(kinds()).toEqual(['person']);
      props.at = T + 3000; // the pointer is over b now
      flushSync();
      expect(kinds()).toEqual(['motion', 'vehicle']);
      expect(img()).toBe('/t/b.jpg');
    });

    // Review of #183: tiles four a second, so the wanted picture changes at
    // every 250 ms step; the popup's at most once a second.
    it('changes the picture at most once a second when the wanted one changes faster', async () => {
      vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { bar, props } = renderMoving();
      const fast: PreviewMinute = { minute, cols: 20, rows: 12, tileW: 160, tileH: 90, intervalS: 0.25, present: Array(240).fill(true), url: '/p.jpg' };
      props.previews = [fast];
      flushSync();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X, bubbles: true }));
      flushSync();
      await tick(200);
      let changes = 0;
      let last = pos();
      for (let k = 1; k <= 12; k++) { // three seconds, a new tile each step
        props.at = T + k * 250;
        flushSync();
        if (pos() !== last) { changes++; last = pos(); }
        await tick(250);
        if (pos() !== last) { changes++; last = pos(); }
      }
      expect(changes).toBeLessThanOrEqual(3);
      expect(changes).toBeGreaterThanOrEqual(2);
    });

    it('leaves no timer behind when it goes away', async () => {
      vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { bar, props } = renderMoving();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X, bubbles: true }));
      flushSync();
      await tick(200);
      props.at = T + 2000; // within the second: a picture is due
      flushSync();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X - 5, bubbles: true })); // another tile: its rest
      flushSync();
      vi.advanceTimersByTime(1); // Svelte's own 0 ms timer after an event
      expect(vi.getTimerCount()).toBe(1); // the rest
      props.at = T + 2250; // following again: a picture due
      flushSync();
      unmount(component!);
      component = undefined;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not change the picture while the tab is hidden, even one already due', async () => {
      vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { bar, props } = renderMoving();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X, bubbles: true }));
      flushSync();
      await tick(200);
      props.at = T + 2000; // due within the second
      flushSync();
      expect(pos()).toBe(posOf(30));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      await tick(1500);
      expect(pos()).toBe(posOf(30));
    });

    it('stops when the pointer has left the bar', async () => {
      vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { bar, props } = renderMoving();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X, bubbles: true }));
      flushSync();
      await tick(200);
      bar.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
      flushSync();
      props.at = T + 2000;
      flushSync();
      await tick(1500);
      expect(q('scrub-preview')).toBeNull();
      expect(q('strip-cursor')).toBeNull();
    });

    it('does not follow in a hidden tab', async () => {
      vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { bar, props } = renderMoving();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: X, bubbles: true }));
      flushSync();
      await tick(1200);
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      props.at = T + 5000;
      flushSync();
      await tick(1500);
      expect(when()).toBe(localClock(T - 270_000));
      expect(pos()).toBe(posOf(30));
    });
  });

});
