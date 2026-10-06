// @vitest-environment jsdom
//
// Klaus, 2026-10-06: the still shown while live connects stays until live's
// first frame is on screen, so LivePlayer reports "playing" only then.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LivePlayer from './LivePlayer.svelte';
import type { PlayerState } from '../lib/liveSession';

vi.mock('../lib/mpegtsPlayer', () => ({
  mpegtsPlayer: () => ({ attach() {}, load() {}, play() {}, destroy() {}, onFailure() {} }),
}));

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
let frames: (() => void)[] = [];
const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
beforeEach(() => {
  frames = [];
  proto.requestVideoFrameCallback = (cb: () => void) => frames.push(cb);
  proto.cancelVideoFrameCallback = () => undefined;
  vi.useFakeTimers();
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  delete proto.requestVideoFrameCallback;
  delete proto.cancelVideoFrameCallback;
  vi.useRealTimers();
});

function render() {
  const states: PlayerState[] = [];
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LivePlayer, { target, props: { cameraId: 'den', quality: 'sub', muted: true, onstate: (s: PlayerState) => states.push(s) } });
  flushSync();
  return states;
}

describe('LivePlayer', () => {
  it('reports playing once the first frame is painted, not on the playing event', () => {
    const states = render();
    expect(states).toEqual(['connecting']);
    target!.querySelector('video')!.dispatchEvent(new Event('playing'));
    expect(states).toEqual(['connecting']);
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(states).toEqual(['connecting', 'playing']);
  });

  it('reports playing after a short wait when nothing paints (a hidden tab)', () => {
    const states = render();
    target!.querySelector('video')!.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(300);
    expect(states).toEqual(['connecting', 'playing']);
  });

  it('reports nothing late after the stream closed', () => {
    const states = render();
    target!.querySelector('video')!.dispatchEvent(new Event('playing'));
    unmount(component!);
    component = undefined;
    frames[0]?.();
    vi.advanceTimersByTime(1000);
    expect(states).toEqual(['connecting']);
  });
});
