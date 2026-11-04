// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_MS, PAUSED_CLASS, runWhileUseful } from './landingAnimations';

type Callback = (entries: { isIntersecting: boolean }[]) => void;
let observers: { callback: Callback; disconnected: boolean }[] = [];

class FakeObserver {
  entry: { callback: Callback; disconnected: boolean };
  constructor(callback: Callback) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

const actions: { destroy?: () => void }[] = [];
function watch(onChange?: (running: boolean) => void): HTMLElement {
  const node = document.createElement('div');
  actions.push(runWhileUseful(node, onChange));
  return node;
}
const paused = (node: HTMLElement) => node.classList.contains(PAUSED_CLASS);

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  for (const a of actions.splice(0)) a.destroy?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('runWhileUseful', () => {
  it('runs on arrival and pauses after 30 s without input', () => {
    const node = watch();
    expect(paused(node)).toBe(false);
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(paused(node)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(paused(node)).toBe(true);
  });

  for (const name of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart']) {
    it(`${name} resumes it and starts the 30 s again`, () => {
      const node = watch();
      vi.advanceTimersByTime(IDLE_MS);
      expect(paused(node)).toBe(true);
      window.dispatchEvent(new Event(name));
      expect(paused(node)).toBe(false);
      vi.advanceTimersByTime(IDLE_MS - 1);
      window.dispatchEvent(new Event(name));
      vi.advanceTimersByTime(IDLE_MS - 1);
      expect(paused(node)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(paused(node)).toBe(true);
    });
  }

  it('pauses off screen, and input does not start what is off screen', () => {
    const node = watch();
    observers[0].callback([{ isIntersecting: false }]);
    expect(paused(node)).toBe(true);
    window.dispatchEvent(new Event('pointermove'));
    expect(paused(node)).toBe(true);
    observers[0].callback([{ isIntersecting: true }]);
    expect(paused(node)).toBe(false);
  });

  it('coming on screen while idle stays paused until the next input', () => {
    const node = watch();
    observers[0].callback([{ isIntersecting: false }]);
    vi.advanceTimersByTime(IDLE_MS);
    observers[0].callback([{ isIntersecting: true }]);
    expect(paused(node)).toBe(true);
    window.dispatchEvent(new Event('keydown'));
    expect(paused(node)).toBe(false);
  });

  it('each element follows its own visibility; the idle pause is shared', () => {
    const [a, b] = [watch(), watch()];
    observers[1].callback([{ isIntersecting: false }]);
    expect([paused(a), paused(b)]).toEqual([false, true]);
    vi.advanceTimersByTime(IDLE_MS);
    expect([paused(a), paused(b)]).toEqual([true, true]);
    window.dispatchEvent(new Event('scroll'));
    expect([paused(a), paused(b)]).toEqual([false, true]);
  });

  it('tells onChange at once, on every change only, and false at the end', () => {
    const onChange = vi.fn();
    watch(onChange);
    expect(onChange.mock.calls).toEqual([[true]]);
    window.dispatchEvent(new Event('pointermove'));
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(IDLE_MS);
    window.dispatchEvent(new Event('pointermove'));
    actions.splice(0)[0].destroy?.();
    expect(onChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(observers[0].disconnected).toBe(true);
  });

  it('without IntersectionObserver it still runs, and still pauses when idle', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const node = watch();
    expect(paused(node)).toBe(false);
    vi.advanceTimersByTime(IDLE_MS);
    expect(paused(node)).toBe(true);
    window.dispatchEvent(new Event('touchstart'));
    expect(paused(node)).toBe(false);
  });

  it('does nothing under reduced motion: no timer for the caller, no class', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const onChange = vi.fn();
    const node = watch(onChange);
    vi.advanceTimersByTime(IDLE_MS);
    expect(paused(node)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);
  });

  it('a page that comes back after everything was destroyed starts alive', () => {
    watch();
    vi.advanceTimersByTime(IDLE_MS);
    actions.splice(0)[0].destroy?.();
    const node = watch();
    expect(paused(node)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });
});
