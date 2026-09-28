// web/src/components/StripPlayer.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StripPlayer from './StripPlayer.svelte';
import { clipRuns, type Coverage } from '../lib/strip';
import type { EventClip } from '../lib/recordings';

const T = Date.parse('2026-09-27T12:00:00-05:00');
const clip: EventClip = { id: '20260927-120010-120020', start: new Date(T + 10_000).toISOString(), end: new Date(T + 20_000).toISOString(), durationSec: 10, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
const cov: Coverage = { clips: clipRuns([clip]), stills: [{ start: T, end: T + 30_000 }], previews: [] };

// jsdom has no media: a video "plays" when the test says so.
beforeEach(() => {
  vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(function (this: HTMLMediaElement) { return Promise.resolve(); }) });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
  // Stills "load" at once.
  vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { queueMicrotask(() => this.onload?.()); } });
});
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function render(extra: Record<string, unknown> = {}) {
  const props = $state({ cam: 'den', coverage: cov, previews: [], now: T + 3_600_000, at: T, playing: false, onclipfail: vi.fn(), onstep: vi.fn(), ...extra });
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(StripPlayer, { target, props });
  flushSync();
  return props;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
};

describe('StripPlayer', () => {
  it('plays stills in real time and says so', async () => {
    const p = render();
    expect(q('source-badge')!.textContent).toBe('Stills 1 FPS');
    q('play-toggle')!.click();
    await tick(3000);
    expect(p.at).toBe(T + 3000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 3000}.jpg`);
  });

  it('switches to the clip at its start, preloaded, and back to stills after it', async () => {
    const p = render({ playing: true, at: T + 5000 });
    await tick(2500); // within 3 s of the clip: preloading
    const vids = [...target!.querySelectorAll('video')] as HTMLVideoElement[];
    expect(vids.some((v) => v.getAttribute('src') === `/api/cameras/den/clips/${clip.id}/video`)).toBe(true);
    await tick(3000);
    expect(q('source-badge')!.textContent).toBe('SD 10 FPS');
    const video = q('clip-video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 10 });
    video.dispatchEvent(new Event('ended'));
    flushSync();
    expect(p.at).toBe(T + 20_000);
    expect(q('source-badge')!.textContent).toBe('Stills 1 FPS');
  });

  it('marks a failing clip once and keeps playing', async () => {
    const onclipfail = vi.fn();
    render({ playing: true, at: T + 10_000, onclipfail });
    (q('clip-video') as HTMLVideoElement).dispatchEvent(new Event('error'));
    flushSync();
    expect(onclipfail).toHaveBeenCalledTimes(1);
    expect(onclipfail).toHaveBeenCalledWith(clip.id);
  });

  it('keeps the last good still when one fails', async () => {
    const bad = `/stills/${T + 2000}.jpg`;
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(v: string) { queueMicrotask(() => (v.endsWith(bad) ? this.onerror?.() : this.onload?.())); } });
    render({ playing: true, coverage: { clips: [], stills: [{ start: T, end: T + 30_000 }], previews: [] } });
    await tick(1000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 1000}.jpg`);
    await tick(1000); // T+2000 fails to load
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 1000}.jpg`);
    await tick(1000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 3000}.jpg`);
  });

  it('shows the panel where nothing was recorded and plays through in real time', async () => {
    const p = render({ coverage: { clips: [], stills: [], previews: [] }, playing: true });
    expect(q('strip-empty')).not.toBeNull();
    expect(q('source-badge')!.textContent).toBe('No recording');
    await tick(5000);
    expect(p.at).toBe(T + 5000);
  });

  it('stops at now and never runs past it', async () => {
    const p = render({ coverage: { clips: [], stills: [], previews: [] }, playing: true, now: T + 2000 });
    await tick(10_000);
    expect(p.at).toBe(T + 2000);
    expect(p.playing).toBe(false);
    expect(q('source-badge')!.textContent).toBe('Live is on the Live page');
  });

  it('does not count time while paused, and a blocked play() leaves it paused', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) });
    const p = render({ at: T + 10_000 });
    await tick(5000);
    expect(p.at).toBe(T + 10_000);
    q('play-toggle')!.click();
    await tick(0);
    expect(p.playing).toBe(false);
  });

  it('plays with Space and steps 10 s with the arrow keys', async () => {
    const p = render();
    const box = q('strip-player')!;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(p.at).toBe(T + 10_000);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    flushSync();
    expect(p.playing).toBe(true);
  });

  it('steps 10 s and to the previous or next event', async () => {
    const onstep = vi.fn();
    const p = render({ onstep });
    q('fwd-10')!.click();
    expect(p.at).toBe(T + 10_000);
    q('back-10')!.click();
    expect(p.at).toBe(T);
    q('next-clip')!.click();
    expect(onstep).toHaveBeenCalledWith(1);
  });
});
