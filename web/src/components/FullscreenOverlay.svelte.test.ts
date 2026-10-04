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
function render(extra: Record<string, unknown> = {}) {
  const acts: FsAction[] = [];
  const props = $state({
    mode: 'rec' as Mode, playing: false, kind: 'element' as 'element' | 'fill',
    onaction: vi.fn((a: FsAction) => { acts.push(a); return true; }), onlive: vi.fn(), onexit: vi.fn(), ...extra,
  });
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(FullscreenOverlay, { target, props });
  flushSync();
  return { props, acts };
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
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
    expect(q('fs-hint')).toBeNull();
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
});
