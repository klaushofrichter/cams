// web/src/components/LivePanel.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LivePanel from './LivePanel.svelte';
import { liveUi } from '../lib/liveUi';
import { get } from 'svelte/store';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
});
const ev = { id: '20260928-091953-092013', start: new Date(Date.now() - 12 * 60_000).toISOString(), end: new Date(Date.now() - 11 * 60_000).toISOString(), durationSec: 20, triggers: ['motion' as const], sizeSub: 1, sizeMain: 1 };
function render(extra: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LivePanel, { target, props: { camera: { id: 'cam2', name: 'cam2', webUiUrl: null }, latest: ev, pending: [], onplay: vi.fn(), proxyInfo: null, ...extra } });
  flushSync();
  return target;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('LivePanel', () => {
  it('names a simulated camera, its model and streams', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: 'cam-sim', streams: { main: { codec: 'h265', width: 4512, height: 2512, fps: 20 }, sub: { codec: 'h264', width: 896, height: 512, fps: 10 } } } }));
    render();
    expect(q('live-camera-kind')!.textContent).toBe('Simulated camera');
    expect(q('live-camera-model')!.textContent).toContain('RLC-1224A');
    expect(q('live-camera-streams')!.textContent).toContain('H.265 4512×2512 @20');
  });

  it('shows the latest event with how long ago, and plays it on click', () => {
    const onplay = vi.fn();
    render({ onplay });
    expect(q('live-latest-ago')!.textContent).toBe('12 minutes ago');
    q('live-latest')!.click();
    expect(onplay).toHaveBeenCalledWith(ev);
  });

  it('shows the offline banner with Retry', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: false, error: 'camera_offline' } }));
    render();
    expect(q('offline-reason')!.textContent).toBe('The camera could not be reached.');
    expect(q('retry')).not.toBeNull();
    expect(get(liveUi).status?.online).toBe(false);
  });

  // Final review: the panel works without the live stream (LiveBox not mounted).
  it('Retry checks the camera again without the live stream', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: 'cam2', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: null, streams: { main: null, sub: null } }), { status: 200 });
    });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: false, error: 'camera_offline' }, checking: false }));
    render();
    q('retry')!.click();
    await vi.waitFor(() => expect(get(liveUi).status?.online).toBe(true));
    expect(urls).toContain('/api/cameras/cam2/status');
    vi.unstubAllGlobals();
  });

  it('Snapshot fetches the camera’s snapshot without the live stream', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response('x', { status: 500 });
    });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true }, snapshotError: '' }));
    render();
    q('snapshot')!.click();
    await vi.waitFor(() => expect(get(liveUi).snapshotError).not.toBe(''));
    expect(urls.some((u) => u.includes('/cam2/snapshot'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('mute toggles without the live stream', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true }, muted: true }));
    render();
    q('mute-toggle')!.click();
    expect(get(liveUi).muted).toBe(false);
  });
});
