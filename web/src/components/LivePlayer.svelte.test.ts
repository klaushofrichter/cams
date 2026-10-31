// @vitest-environment jsdom
//
// Klaus, 2026-10-06: the still shown while live connects stays until live's
// first frame is on screen, so LivePlayer reports "playing" only then.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LivePlayer from './LivePlayer.svelte';
import type { PlayerState } from '../lib/liveSession';

const urls = vi.hoisted(() => ({ mpegts: [] as string[], fmp4: [] as string[] }));
vi.mock('../lib/mpegtsPlayer', () => ({
  mpegtsPlayer: (url: string) => (urls.mpegts.push(url), { attach() {}, load() {}, play() {}, destroy() {}, onFailure() {} }),
}));
vi.mock('../lib/fmp4Player', () => ({
  fmp4Player: (url: string) => (urls.fmp4.push(url), { attach() {}, load() {}, play() {}, destroy() {}, onFailure() {} }),
}));
import { cameras } from '../lib/stores';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
let frames: (() => void)[] = [];
const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
beforeEach(() => {
  frames = [];
  proto.requestVideoFrameCallback = (cb: () => void) => frames.push(cb);
  proto.cancelVideoFrameCallback = () => undefined;
  vi.useFakeTimers();
  urls.mpegts.length = urls.fmp4.length = 0;
  cameras.set([{ id: 'den', name: 'Den', webUiUrl: null }]);
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

describe('LivePlayer player choice', () => {
  it('plays a camera without a proxy through mpegts.js (FLV)', () => {
    render();
    expect(urls.mpegts).toEqual(['/api/cameras/den/live?quality=sub']);
    expect(urls.fmp4).toEqual([]);
  });

  it('plays a through-proxy camera as fMP4, naming the codecs the browser takes', () => {
    vi.stubGlobal('MediaSource', { isTypeSupported: (t: string) => !t.includes('hvc1') });
    try {
      cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, throughProxy: true }]);
      render();
      expect(urls.fmp4).toEqual([`/api/cameras/den/live?quality=sub&codecs=${encodeURIComponent('avc1.640029,avc1.64002A,avc1.640033,mp4a.40.2')}`]);
      expect(urls.mpegts).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
