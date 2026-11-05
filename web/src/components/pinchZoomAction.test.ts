// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinchZoom, type ZoomState } from '../lib/pinchZoom';

// The action on a frame: which strokes it takes, and what it leaves to the
// page. jsdom has no layout, so the frame's size is stubbed (400 x 225).
let frame: HTMLDivElement;
let picture: HTMLDivElement;
let button: HTMLButtonElement;
let state: ZoomState;
let action: ReturnType<typeof pinchZoom>;

type Pt = [number, number];
function touch(type: string, on: Element, fingers: Pt[], opts: { cancelable?: boolean } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: opts.cancelable ?? true });
  const touches = fingers.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY, target: on }));
  Object.defineProperty(e, 'touches', { value: touches });
  on.dispatchEvent(e);
  return e;
}
const pinch = (from: [Pt, Pt], to: [Pt, Pt], on: Element = picture) => {
  touch('touchstart', on, [from[0]]);
  touch('touchstart', on, from);
  const moved = touch('touchmove', on, to);
  touch('touchend', on, [to[0]]);
  touch('touchend', on, []);
  return moved;
};
const tap = (at: Pt, on: Element = picture) => {
  touch('touchstart', on, [at]);
  return touch('touchend', on, []);
};
const zoomIn = () => pinch([[150, 100], [250, 100]], [[50, 100], [350, 100]]);
const transform = () => frame.style.getPropertyValue('--media-zoom');

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  frame = document.createElement('div');
  picture = document.createElement('div');
  button = document.createElement('button');
  frame.append(picture, button);
  document.body.append(frame);
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 225, right: 400, bottom: 225, x: 0, y: 0, toJSON: () => ({}) });
  state = { zoomed: false, strokeTaken: false };
  action = pinchZoom(frame, { key: 'a', onchange: (s) => (state = s) });
});
afterEach(() => {
  action.destroy();
  vi.useRealTimers();
});

describe('pinchZoom', () => {
  it('two fingers zoom the picture, and refuse the browser the gesture', () => {
    const moved = zoomIn();
    expect(moved.defaultPrevented).toBe(true);
    expect(transform()).toContain('matrix(3, 0, 0, 3');
    expect(state).toEqual({ zoomed: true, strokeTaken: true });
    expect(frame.style.touchAction).toBe('none');
    expect(frame.style.overflow).toBe('hidden');
  });

  it('one finger at 1x is the page\'s: nothing refused, nothing taken', () => {
    const start = touch('touchstart', picture, [[100, 100]]);
    const move = touch('touchmove', picture, [[100, 40]]);
    const end = touch('touchend', picture, []);
    for (const e of [start, move, end]) expect(e.defaultPrevented).toBe(false);
    expect(transform()).toBe('');
    expect(state).toEqual({ zoomed: false, strokeTaken: false });
    expect(frame.style.touchAction).toBe('');
  });

  it('one finger while zoomed pans, within the picture', () => {
    zoomIn();
    const before = transform();
    touch('touchstart', picture, [[200, 100]]);
    expect(state.strokeTaken).toBe(false);
    const m = touch('touchmove', picture, [[170, 100]]);
    expect(m.defaultPrevented).toBe(true);
    expect(transform()).not.toBe(before);
    expect(state.strokeTaken).toBe(true);
    touch('touchmove', picture, [[9000, 100]]);
    expect(transform()).toContain('matrix(3, 0, 0, 3, 0,'); // the left edge stops at the frame's
    touch('touchend', picture, []);
  });

  it('does not jump when one finger of a pinch lifts and the other goes on', () => {
    touch('touchstart', picture, [[150, 100]]);
    touch('touchstart', picture, [[150, 100], [250, 100]]);
    touch('touchmove', picture, [[50, 100], [350, 100]]);
    touch('touchend', picture, [[350, 100]]);
    const before = transform();
    touch('touchmove', picture, [[350, 100]]);
    expect(transform()).toBe(before);
    touch('touchend', picture, []);
    expect(state.strokeTaken).toBe(true);
  });

  it('a tap while zoomed is not taken and leaves the zoom', () => {
    zoomIn();
    tap([200, 100]);
    expect(state).toEqual({ zoomed: true, strokeTaken: false });
  });

  it('a double tap while zoomed returns to 1x, a double tap at 1x does nothing', () => {
    tap([200, 100]);
    vi.advanceTimersByTime(100);
    const atOne = tap([200, 100]);
    expect(atOne.defaultPrevented).toBe(false);
    expect(transform()).toBe('');
    zoomIn();
    vi.advanceTimersByTime(1000);
    tap([200, 100]);
    vi.advanceTimersByTime(150);
    const second = tap([202, 101]);
    expect(second.defaultPrevented).toBe(true);
    expect(transform()).toBe('');
    expect(state).toEqual({ zoomed: false, strokeTaken: true });
    expect(frame.style.touchAction).toBe('');
    // A soft snap, and the frame clips until it has ended.
    expect(frame.style.getPropertyValue('--media-zoom-t')).toBe('160ms');
    expect(frame.style.overflow).toBe('hidden');
    vi.advanceTimersByTime(200);
    expect(frame.style.getPropertyValue('--media-zoom-t')).toBe('');
    expect(frame.style.overflow).toBe('');
    // The next stroke is free again.
    touch('touchstart', picture, [[200, 100]]);
    expect(state.strokeTaken).toBe(false);
    touch('touchend', picture, []);
  });

  // Double tap at 1x (Klaus, 2026-11-05): the player's fullscreen, when asked for.
  it('a double tap at 1x calls ondoubletap once, takes the tap from the page, and keeps 1x', () => {
    const calls = vi.fn();
    action.update({ key: 'a', onchange: (z) => (state = z), ondoubletap: calls });
    const first = tap([200, 100]);
    expect(first.defaultPrevented).toBe(false); // a single tap stays the page's
    vi.advanceTimersByTime(200);
    const second = tap([205, 104]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(true);
    expect(transform()).toBe('');
    // A third tap starts over: no second call.
    vi.advanceTimersByTime(100);
    tap([200, 100]);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('at 1x: two slow taps, two far apart, a drag or a button are no double tap', () => {
    const calls = vi.fn();
    action.update({ key: 'a', ondoubletap: calls });
    tap([200, 100]);
    vi.advanceTimersByTime(500);
    tap([200, 100]);
    vi.advanceTimersByTime(500);
    tap([20, 20]);
    vi.advanceTimersByTime(100);
    tap([300, 200]);
    vi.advanceTimersByTime(500);
    tap([200, 100], button);
    vi.advanceTimersByTime(100);
    tap([200, 100], button);
    vi.advanceTimersByTime(500);
    touch('touchstart', picture, [[200, 100]]);
    touch('touchmove', picture, [[200, 160]]);
    touch('touchend', picture, []);
    vi.advanceTimersByTime(100);
    tap([200, 160]);
    expect(calls).not.toHaveBeenCalled();
  });

  it('zoomed, a double tap returns to 1x and is not ondoubletap', () => {
    const calls = vi.fn();
    action.update({ key: 'a', onchange: (z) => (state = z), ondoubletap: calls });
    zoomIn();
    vi.advanceTimersByTime(1000);
    tap([200, 100]);
    vi.advanceTimersByTime(150);
    tap([200, 100]);
    expect(transform()).toBe('');
    expect(calls).not.toHaveBeenCalled();
    // And a tap right after it is a first tap, not the second of another double.
    vi.advanceTimersByTime(100);
    tap([200, 100]);
    expect(calls).not.toHaveBeenCalled();
  });

  it('with reduced motion the snap is instant', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    zoomIn();
    vi.advanceTimersByTime(1000);
    tap([200, 100]);
    tap([200, 100]);
    expect(transform()).toBe('');
    expect(frame.style.getPropertyValue('--media-zoom-t')).toBe('');
    expect(frame.style.overflow).toBe('');
    vi.unstubAllGlobals();
  });

  it('two slow taps are no double tap', () => {
    zoomIn();
    vi.advanceTimersByTime(1000);
    tap([200, 100]);
    vi.advanceTimersByTime(800);
    tap([200, 100]);
    expect(state.zoomed).toBe(true);
  });

  it('pinching back to 1x resets, with nothing left of the pan', () => {
    zoomIn();
    pinch([[50, 100], [350, 100]], [[190, 100], [210, 100]]);
    expect(transform()).toBe('');
    expect(state.zoomed).toBe(false);
  });

  it('a touch on a button is the button\'s', () => {
    const start = touch('touchstart', button, [[10, 10]]);
    touch('touchstart', button, [[10, 10], [100, 10]]);
    const move = touch('touchmove', button, [[10, 10], [300, 10]]);
    touch('touchend', button, []);
    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
    expect(transform()).toBe('');
  });

  it('a page already scrolling keeps its stroke: a late second finger does not zoom', () => {
    touch('touchstart', picture, [[100, 100]]);
    touch('touchmove', picture, [[100, 80]], { cancelable: false });
    touch('touchstart', picture, [[100, 80], [200, 80]], { cancelable: false });
    touch('touchmove', picture, [[50, 80], [300, 80]], { cancelable: false });
    touch('touchend', picture, []);
    expect(transform()).toBe('');
  });

  it('goes on when the layer under the fingers leaves the page mid-pinch', () => {
    touch('touchstart', picture, [[150, 100]]);
    touch('touchstart', picture, [[150, 100], [250, 100]]);
    picture.remove(); // a still giving way to the video
    const moved = touch('touchmove', picture, [[50, 100], [350, 100]]);
    expect(moved.defaultPrevented).toBe(true);
    expect(transform()).toContain('matrix(3, 0, 0, 3');
    touch('touchend', picture, []);
    expect(state.zoomed).toBe(true);
    frame.prepend(picture);
  });

  it('a stroke whose end never came is over at the next first finger', () => {
    const lost = document.createElement('div');
    frame.append(lost);
    touch('touchstart', lost, [[150, 100]]);
    lost.remove();
    tap([200, 100]);
    expect(state.strokeTaken).toBe(false);
    // Its finger is gone from the touches, so this is one finger: no pinch.
    expect(transform()).toBe('');
  });

  it('a click on the picture is swallowed while zoomed, a button\'s is not', () => {
    const onPicture = vi.fn();
    picture.addEventListener('click', onPicture);
    const onButton = vi.fn();
    button.addEventListener('click', onButton);
    picture.click();
    expect(onPicture).toHaveBeenCalledTimes(1);
    zoomIn();
    picture.click();
    button.click();
    expect(onPicture).toHaveBeenCalledTimes(1);
    expect(onButton).toHaveBeenCalledTimes(1);
  });

  it('a new key resets, the same key does not', () => {
    zoomIn();
    action.update({ key: 'a', onchange: (s) => (state = s) });
    expect(state.zoomed).toBe(true);
    action.update({ key: 'b', onchange: (s) => (state = s) });
    expect(state.zoomed).toBe(false);
    expect(transform()).toBe('');
  });

  it('removes its listeners', () => {
    action.destroy();
    const move = (touch('touchstart', picture, [[150, 100], [250, 100]]), touch('touchmove', picture, [[50, 100], [350, 100]]));
    expect(move.defaultPrevented).toBe(false);
    action = pinchZoom(frame, {});
  });
});
