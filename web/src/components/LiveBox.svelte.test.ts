// web/src/components/LiveBox.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveBox from './LiveBox.svelte';
import { liveUi } from '../lib/liveUi';

// jsdom has no MediaSource: a player that never plays.
vi.mock('../lib/mpegtsPlayer', () => ({
  mpegtsPlayer: () => ({ attach() {}, load() {}, play() {}, destroy() {}, onFailure() {} }),
}));

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/status') ? { id: 'cam1', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: 'cam-sim', streams: { main: null, sub: null } } : {}), { status: 200 }));
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
});

describe('LiveBox', () => {
  it('checks the camera and shares its status', async () => {
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(LiveBox, { target, props: { cameraId: 'cam1', visible: true, audible: true, proxy: false } });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(get(liveUi).status).toMatchObject({ online: true, simulator: 'cam-sim' });
  });
});
