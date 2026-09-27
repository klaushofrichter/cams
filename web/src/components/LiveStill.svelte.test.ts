// @vitest-environment jsdom
//
// Plan 7: while live video isn't playing, Live shows the camera gateway's
// newest still. Review fixes: a new still is asked for only once the last
// one has loaded (I2), nothing polls while Live is hidden (M2), and nothing
// is drawn until a still has loaded (I1).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveStill from './LiveStill.svelte';

// A stand-in for the browser's Image: the test decides when a load ends.
const loads: FakeImage[] = [];
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    loads.push(this);
  }
}

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  loads.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('Image', FakeImage);
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(props: { cameraId: string; active?: boolean }) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LiveStill, { target, props });
  flushSync();
}
const shown = () => target!.querySelector('[data-testid="live-still"] img')?.getAttribute('src') ?? null;

describe('LiveStill', () => {
  it('shows a still once loaded, and asks for the next only when the last one is done', () => {
    render({ cameraId: 'den' });
    expect(loads).toHaveLength(1);
    expect(loads[0].src).toMatch(/^\/api\/cameras\/den\/still\/latest\.jpg\?t=\d+$/);
    expect(shown()).toBeNull(); // nothing drawn before a still has loaded
    vi.advanceTimersByTime(3000);
    expect(loads).toHaveLength(1); // still loading: no second request
    loads[0].onload!();
    flushSync();
    expect(shown()).toBe(loads[0].src);
    vi.advanceTimersByTime(1000);
    expect(loads).toHaveLength(2);
  });

  it('hides after a failed load and tries again after 5 s', () => {
    render({ cameraId: 'den' });
    loads[0].onload!();
    flushSync();
    vi.advanceTimersByTime(1000);
    loads[1].onerror!();
    flushSync();
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(loads).toHaveLength(2);
    vi.advanceTimersByTime(3000);
    expect(loads).toHaveLength(3);
  });

  it('asks for nothing while Live is hidden', () => {
    render({ cameraId: 'den', active: false });
    vi.advanceTimersByTime(5000);
    expect(loads).toHaveLength(0);
  });
});
