// @vitest-environment jsdom
//
// Plan 7: while live video isn't playing, Live shows the camera gateway's
// newest still, reloaded every second; nothing when there is none.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveStill from './LiveStill.svelte';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
});

describe('LiveStill', () => {
  it('reloads the newest still every second, and hides when there is none', () => {
    vi.useFakeTimers();
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(LiveStill, { target, props: { cameraId: 'den' } });
    flushSync();
    const img = () => target!.querySelector('[data-testid="live-still"] img') as HTMLImageElement | null;
    const first = img()!.getAttribute('src')!;
    expect(first).toMatch(/^\/api\/cameras\/den\/still\/latest\.jpg\?t=\d+$/);
    vi.advanceTimersByTime(1000);
    flushSync();
    expect(img()!.getAttribute('src')).not.toBe(first);
    img()!.dispatchEvent(new Event('error'));
    flushSync();
    expect(target.querySelector('[data-testid="live-still"]')).toBeNull();
    // It tries again later.
    vi.advanceTimersByTime(5000);
    flushSync();
    expect(img()).not.toBeNull();
  });
});
