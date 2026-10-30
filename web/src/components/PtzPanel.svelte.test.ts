// @vitest-environment jsdom
// The PTZ panel's controls (cam-proxy spec 2026-10-30-ptz-capabilities-design
// §8.2): collapsed by default, a direction pad (tap a step, hold to move),
// zoom and focus; every hold ends with a stop, whatever ends it.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PtzPanel from './PtzPanel.svelte';
import type { PtzCapabilities } from '../lib/ptz';

const ALL: PtzCapabilities = { move: true, zoom: true, focus: true, speed: true, positions: null };

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
let calls: { url: string; method: string; body: unknown }[];
let answer: (url: string) => Response;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  calls = [];
  answer = () => new Response(null, { status: 204 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return answer(url);
    }),
  );
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

function render(props: { cameraId?: string; ptz?: PtzCapabilities } = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(PtzPanel, { target, props: { cameraId: props.cameraId ?? 'den', ptz: props.ptz ?? ALL } });
  flushSync();
  return target;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const open = () => {
  q('ptz-toggle')!.click();
  flushSync();
};
const down = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
const up = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
const moves = () => calls.filter((c) => c.url.endsWith('/ptz/move'));
const stops = (cam = 'den') => calls.filter((c) => c.url === `/api/cameras/${cam}/ptz/stop`);

describe('PtzPanel', () => {
  it('is collapsed by default and remembers being opened', () => {
    render();
    expect(q('ptz-panel')).not.toBeNull();
    expect(q('ptz-body')).toBeNull();
    expect(q('ptz-toggle')!.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(q('ptz-body')).not.toBeNull();
    expect(q('ptz-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem('cams-ptz-open')).toBe('1');
    unmount(component!);
    target!.remove();
    render();
    expect(q('ptz-body')).not.toBeNull();
  });

  it('renders when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render();
    expect(q('ptz-panel')).not.toBeNull();
    open();
    expect(q('ptz-body')).not.toBeNull();
  });

  it('shows the eight directions, zoom, and focus only when the camera can focus', () => {
    render({ ptz: { ...ALL, focus: false } });
    open();
    for (const d of ['left', 'right', 'up', 'down', 'left-up', 'left-down', 'right-up', 'right-down']) expect(q(`ptz-dir-${d}`)).not.toBeNull();
    expect(q('ptz-dir-up')!.getAttribute('aria-label')).toBe('Move up');
    expect(q('ptz-dir-left-up')!.getAttribute('aria-label')).toBe('Move up-left');
    expect(q('ptz-zoom-in')).not.toBeNull();
    expect(q('ptz-focus-near')).toBeNull();
  });

  it('a tap sends one move of 400 ms', async () => {
    render();
    open();
    down(q('ptz-dir-left')!);
    await vi.advanceTimersByTimeAsync(100);
    up(q('ptz-dir-left')!);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual([{ url: '/api/cameras/den/ptz/move', method: 'POST', body: { direction: 'left', durationMs: 400 } }]);
  });

  it('a hold sends a move every 250 ms with 600 ms, then stop on release', async () => {
    render();
    open();
    down(q('ptz-dir-right-up')!);
    await vi.advanceTimersByTimeAsync(800);
    up(q('ptz-dir-right-up')!);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.map((c) => [c.url.split('/').pop(), (c.body as { durationMs?: number }).durationMs])).toEqual([
      ['move', 400],
      ['move', 600],
      ['move', 600],
      ['move', 600],
      ['stop', undefined],
    ]);
    expect(moves()[1].body).toEqual({ direction: 'right-up', durationMs: 600 });
  });

  it('pointerleave during a hold stops', async () => {
    render();
    open();
    down(q('ptz-dir-up')!);
    await vi.advanceTimersByTimeAsync(300);
    q('ptz-dir-up')!.dispatchEvent(new MouseEvent('pointerleave', { bubbles: false }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stops()).toHaveLength(1);
    expect(moves()).toHaveLength(2);
  });

  it('a keyboard press works like a pointer: Enter held, then released', async () => {
    render();
    open();
    const b = q('ptz-dir-down')!;
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }));
    b.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(moves()).toHaveLength(2);
    expect(stops()).toHaveLength(1);
  });

  it('hiding the tab stops a hold', async () => {
    render();
    open();
    down(q('ptz-dir-left')!);
    await vi.advanceTimersByTimeAsync(300);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stops()).toHaveLength(1);
    expect(moves()).toHaveLength(2);
  });

  it('the window losing focus stops a hold', async () => {
    render();
    open();
    down(q('ptz-dir-left')!);
    await vi.advanceTimersByTimeAsync(300);
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stops()).toHaveLength(1);
  });

  it('switching the camera mid-hold stops the old camera', async () => {
    const props = $state({ cameraId: 'den', ptz: ALL });
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(PtzPanel, { target, props });
    flushSync();
    open();
    down(q('ptz-dir-left')!);
    await vi.advanceTimersByTimeAsync(300);
    props.cameraId = 'barn';
    flushSync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stops('den')).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith('/api/cameras/barn/'))).toEqual([]);
    expect(moves()).toHaveLength(2);
  });

  it('unmounting mid-hold stops', async () => {
    render();
    open();
    down(q('ptz-dir-left')!);
    await vi.advanceTimersByTimeAsync(300);
    unmount(component!);
    component = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect(stops()).toHaveLength(1);
    expect(moves()).toHaveLength(2);
  });

  it('collapsing the panel mid-hold stops the camera and the repeats', async () => {
    render();
    open();
    down(q('ptz-dir-left')!);
    await vi.advanceTimersByTimeAsync(300);
    q('ptz-toggle')!.click();
    flushSync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stops()).toHaveLength(1);
    expect(moves()).toHaveLength(2);
  });

  it('zoom + held sends zoom in, then stop', async () => {
    render();
    open();
    down(q('ptz-zoom-in')!);
    await vi.advanceTimersByTimeAsync(300);
    up(q('ptz-zoom-in')!);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ['/api/cameras/den/ptz/zoom', { direction: 'in', durationMs: 400 }],
      ['/api/cameras/den/ptz/zoom', { direction: 'in', durationMs: 600 }],
      ['/api/cameras/den/ptz/stop', {}],
    ]);
  });

  it('focus far sends focus', async () => {
    render();
    open();
    down(q('ptz-focus-far')!);
    up(q('ptz-focus-far')!);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([{ url: '/api/cameras/den/ptz/focus', method: 'POST', body: { direction: 'far', durationMs: 400 } }]);
  });

  it('shows a refused move inline and stops repeating; the next good press clears it', async () => {
    answer = () => new Response(JSON.stringify({ error: 'camera_offline' }), { status: 503 });
    render();
    open();
    down(q('ptz-dir-left')!);
    await vi.advanceTimersByTimeAsync(300);
    flushSync();
    expect(q('ptz-error')!.textContent).toBe('The camera is offline.');
    expect(q('ptz-error')!.getAttribute('role')).toBe('alert');
    const n = moves().length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(moves()).toHaveLength(n);
    expect(n).toBeLessThanOrEqual(2);
    up(q('ptz-dir-left')!);
    answer = () => new Response(null, { status: 204 });
    down(q('ptz-dir-up')!);
    up(q('ptz-dir-up')!);
    await vi.advanceTimersByTimeAsync(10);
    flushSync();
    expect(q('ptz-error')).toBeNull();
  });

  it('ignores a secondary mouse button', async () => {
    render();
    open();
    q('ptz-dir-left')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual([]);
  });
});
