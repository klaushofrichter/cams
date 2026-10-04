// web/src/components/FullscreenOverlay.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FullscreenOverlay from './FullscreenOverlay.svelte';
import type { FsAction } from '../lib/playerFullscreen';
import type { Mode } from '../lib/videoMode';

// The fullscreen overlay (#182, spec 2026-10-04-fullscreen-recorded):
// controls that hide after 3 s, keys, phone gestures, a hint.
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
});
// The page around the player: a sidebar and the strip beside the box.
let page: HTMLDivElement | undefined;
afterEach(() => {
  page?.remove();
  page = undefined;
});
function render(extra: Record<string, unknown> = {}, inPage = false) {
  const acts: FsAction[] = [];
  const props = $state({
    mode: 'rec' as Mode, playing: false, kind: 'element' as 'element' | 'fill', canPrev: true, canNext: true,
    onaction: vi.fn((a: FsAction) => { acts.push(a); return true; }), onlive: vi.fn(), onexit: vi.fn(), ...extra,
  });
  target = document.createElement('div');
  if (inPage) {
    page = document.createElement('div');
    page.innerHTML = '<aside><button data-testid="outside">Fullscreen</button><div data-testid="was-inert" inert></div></aside><div class="player"><div class="strip"><button data-testid="strip-btn">x</button></div></div>';
    page.querySelector('.player')!.prepend(target);
    document.body.appendChild(page);
    (page.querySelector('[data-testid="outside"]') as HTMLElement).focus();
  } else document.body.appendChild(target);
  component = mount(FullscreenOverlay, { target, props });
  flushSync();
  return { props, acts };
}
const q = (id: string) => (page ?? target!).querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const shown = () => q('fs-overlay')!.dataset.shown;
const tick = (ms: number) => {
  vi.advanceTimersByTime(ms);
  flushSync();
};
// jsdom has no layout: the gesture layer is 0 px wide unless told otherwise.
function sized(w = 900) {
  const layer = q('fs-gestures')!;
  layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: 500, right: w, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  return layer;
}
function stroke(layer: HTMLElement, x0: number, x1: number, ms = 100, type = 'touch') {
  const ev = (name: string, x: number) => {
    const e = new Event(name, { bubbles: true }) as Event & Record<string, unknown>;
    Object.assign(e, { clientX: x, clientY: 250, pointerId: 1, pointerType: type, isPrimary: true, button: 0 });
    return e;
  };
  layer.dispatchEvent(ev('pointerdown', x0));
  vi.advanceTimersByTime(ms);
  layer.dispatchEvent(ev('pointerup', x1));
  flushSync();
}
const key = (k: string, mods: KeyboardEventInit = {}) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
  flushSync();
};

describe('FullscreenOverlay', () => {
  it('shows the controls, then hides them after 3 s without input', () => {
    render();
    expect(shown()).toBe('true');
    tick(2900);
    expect(shown()).toBe('true');
    tick(200);
    expect(shown()).toBe('false');
    q('fs-overlay')!.dispatchEvent(new Event('pointermove', { bubbles: true }));
    flushSync();
    expect(shown()).toBe('true');
  });

  it('a recording: every button acts', () => {
    const { acts, props } = render();
    for (const id of ['fs-prev-event', 'fs-back-10', 'fs-back-1', 'fs-play', 'fs-fwd-1', 'fs-fwd-10', 'fs-next-event']) {
      expect(q(id)!.disabled, id).toBe(false);
      q(id)!.click();
    }
    expect(acts).toEqual([
      { kind: 'event', dir: -1 }, { kind: 'skip', ms: -10_000 }, { kind: 'skip', ms: -1000 }, { kind: 'toggle' },
      { kind: 'skip', ms: 1000 }, { kind: 'skip', ms: 10_000 }, { kind: 'event', dir: 1 },
    ]);
    q('fs-live')!.click();
    expect(props.onlive).toHaveBeenCalledTimes(1);
    q('fs-exit')!.click();
    expect(props.onexit).toHaveBeenCalledTimes(1);
  });

  it('live: nothing after now, and no way "back to live"', () => {
    render({ mode: 'live' });
    for (const id of ['fs-play', 'fs-fwd-1', 'fs-fwd-10', 'fs-next-event', 'fs-live']) expect(q(id)!.disabled, id).toBe(true);
    for (const id of ['fs-prev-event', 'fs-back-10', 'fs-back-1', 'fs-exit']) expect(q(id)!.disabled, id).toBe(false);
  });

  it('keys: arrows, Shift+arrows, [ ] PgUp PgDn, Space; Esc leaves', () => {
    const { acts, props } = render();
    key('ArrowLeft');
    key('ArrowRight', { shiftKey: true });
    key('[');
    key('PageDown');
    key(' ');
    key('ArrowLeft', { altKey: true }); // the browser's Back
    expect(acts).toEqual([{ kind: 'skip', ms: -10_000 }, { kind: 'skip', ms: 1000 }, { kind: 'event', dir: -1 }, { kind: 'event', dir: 1 }, { kind: 'toggle' }]);
    key('Escape');
    expect(props.onexit).toHaveBeenCalledTimes(1);
  });

  it('a key shows the controls again and a hint', () => {
    render();
    tick(3500);
    expect(shown()).toBe('false');
    key('ArrowRight');
    expect(shown()).toBe('true');
    expect(q('fs-hint')!.textContent).toBe('+10 s');
    tick(800);
    expect(q('fs-hint')!.textContent).toBe('');
  });

  it('touch: the first tap while hidden only shows the controls; then the thirds act', () => {
    const { acts } = render();
    const layer = sized(900);
    tick(3500);
    stroke(layer, 100, 100); // hidden: only shows
    expect(acts).toEqual([]);
    expect(shown()).toBe('true');
    stroke(layer, 100, 100);
    stroke(layer, 450, 451);
    stroke(layer, 800, 800);
    expect(acts).toEqual([{ kind: 'skip', ms: -10_000 }, { kind: 'toggle' }, { kind: 'skip', ms: 10_000 }]);
    expect(q('fs-hint')!.textContent).toBe('+10 s');
  });

  it('touch: a swipe acts at once, even while hidden; an edge swipe does nothing', () => {
    const { acts } = render();
    const layer = sized(900);
    tick(3500);
    stroke(layer, 500, 400); // left: forward
    expect(acts).toEqual([{ kind: 'skip', ms: 1000 }]);
    expect(q('fs-hint')!.textContent).toBe('+1 s');
    stroke(layer, 400, 500); // right: back
    stroke(layer, 5, 200); // from the edge: iOS Back
    expect(acts).toEqual([{ kind: 'skip', ms: 1000 }, { kind: 'skip', ms: -1000 }]);
  });

  it('live: taps and swipes only show the controls', () => {
    const { acts } = render({ mode: 'live' });
    const layer = sized(900);
    stroke(layer, 100, 100);
    stroke(layer, 500, 400);
    expect(acts).toEqual([]);
  });

  it('a mouse click on the picture plays or pauses', () => {
    const { acts } = render();
    const layer = sized(900);
    stroke(layer, 100, 100, 80, 'mouse');
    expect(acts).toEqual([{ kind: 'toggle' }]);
    expect(q('fs-hint')!.textContent).toBe('▶');
  });

  // Review of #185.
  it('takes the focus, and gives it back on leaving', () => {
    render({}, true);
    expect(document.activeElement).toBe(q('fs-overlay'));
    unmount(component!);
    component = undefined;
    expect(document.activeElement).toBe(q('outside'));
  });

  it('makes the page outside the player box inert while fullscreen, and only that', () => {
    render({}, true);
    expect(q('outside')!.closest('aside')!.hasAttribute('inert')).toBe(true);
    expect(q('strip-btn')!.closest('.strip')!.hasAttribute('inert')).toBe(true);
    expect(target!.hasAttribute('inert')).toBe(false);
    expect(target!.closest('.player')!.hasAttribute('inert')).toBe(false);
    unmount(component!);
    component = undefined;
    expect(q('outside')!.closest('aside')!.hasAttribute('inert')).toBe(false);
    expect(q('strip-btn')!.closest('.strip')!.hasAttribute('inert')).toBe(false);
    expect(q('was-inert')!.hasAttribute('inert')).toBe(true); // inert before: stays so
  });

  it('one action per key: a key aimed outside the box is not the overlay\'s', () => {
    const { acts } = render({}, true);
    q('strip-btn')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    flushSync();
    expect(acts).toEqual([]);
    q('fs-overlay')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    flushSync();
    expect(acts).toEqual([{ kind: 'skip', ms: 10_000 }]);
  });

  it('keeps the hint\'s live region mounted, so each hint is announced', () => {
    render();
    const region = q('fs-hint')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('');
    key('ArrowLeft');
    expect(q('fs-hint')).toBe(region);
    expect(region.textContent).toBe('−10 s');
    tick(800);
    expect(q('fs-hint')).toBe(region);
    expect(region.textContent).toBe('');
  });

  it('turns ⏮ / ⏭ off at the first / last event, and no hint where nothing jumped', () => {
    const { props } = render({ canPrev: false, canNext: true, onaction: vi.fn(() => false) });
    expect(q('fs-prev-event')!.disabled).toBe(true);
    expect(q('fs-next-event')!.disabled).toBe(false);
    key(']');
    expect(props.onaction).toHaveBeenCalledWith({ kind: 'event', dir: 1 });
    expect(q('fs-hint')!.textContent).toBe('');
    props.canPrev = true;
    props.canNext = false;
    flushSync();
    expect(q('fs-prev-event')!.disabled).toBe(false);
    expect(q('fs-next-event')!.disabled).toBe(true);
  });

  it('Tab goes round inside the player box', () => {
    render({ mode: 'live' }, true);
    const tab = (shiftKey = false) => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      (document.activeElement ?? window).dispatchEvent(e);
      flushSync();
      return e.defaultPrevented;
    };
    expect(tab()).toBe(true); // from the overlay itself: the first button
    expect(document.activeElement).toBe(q('fs-prev-event'));
    q('fs-exit')!.focus();
    expect(tab()).toBe(true); // the last: round to the first
    expect(document.activeElement).toBe(q('fs-prev-event'));
    expect(tab(true)).toBe(true); // and back
    expect(document.activeElement).toBe(q('fs-exit'));
    q('fs-back-10')!.focus();
    expect(tab()).toBe(false); // in between: the browser's own Tab
  });
});
