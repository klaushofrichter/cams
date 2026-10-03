// web/src/components/LiveBox.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveBox from './LiveBox.svelte';
import { liveUi } from '../lib/liveUi';
import { preferences, type Preferences } from '../lib/preferences';

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
  it('leaves no stale player state behind when the stream closes (final review)', async () => {
    target = document.createElement('div');
    document.body.appendChild(target);
    liveUi.update((u) => ({ ...u, status: { id: 'cam1', online: true } }));
    component = mount(LiveBox, { target, props: { cameraId: 'cam1', visible: true, audible: true, proxy: false } });
    flushSync();
    liveUi.update((u) => ({ ...u, playerState: 'playing', badge: '● LIVE' }));
    unmount(component);
    component = undefined;
    expect(get(liveUi)).toMatchObject({ playerState: 'connecting', badge: '● …', stillsShowing: false });
  });

  describe('connecting indicator', () => {
    const open = (status: { id: string; online: boolean } | null, keepAlive?: Preferences['liveKeepAlive']) => {
      preferences.set(keepAlive === undefined ? null : ({ liveKeepAlive: keepAlive } as Preferences));
      liveUi.update((u) => ({ ...u, status, playerState: 'connecting', stillsShowing: false }));
      target = document.createElement('div');
      document.body.appendChild(target);
      component = mount(LiveBox, { target, props: { cameraId: 'cam1', visible: true, audible: true, proxy: false } });
      flushSync();
    };
    const overlay = () => target!.querySelector('[data-testid="live-connecting"]');
    afterEach(() => preferences.set(null));

    it('shows while connecting and goes once the stream plays', () => {
      open({ id: 'cam1', online: true }, 60);
      expect(overlay()).not.toBeNull();
      expect(overlay()!.getAttribute('role')).toBe('status');
      expect(overlay()!.getAttribute('aria-live')).toBe('polite');
      expect(overlay()!.querySelector('.spinner')!.getAttribute('aria-hidden')).toBe('true');
      expect(overlay()!.textContent).toContain('Connecting to the live stream…');
      liveUi.update((u) => ({ ...u, playerState: 'playing' }));
      flushSync();
      expect(overlay()).toBeNull();
    });

    it('comes back as reconnecting after a drop', () => {
      open({ id: 'cam1', online: true }, 60);
      liveUi.update((u) => ({ ...u, playerState: 'playing' }));
      flushSync();
      liveUi.update((u) => ({ ...u, playerState: 'reconnecting' }));
      flushSync();
      expect(overlay()!.textContent).toContain('Reconnecting to the live stream…');
    });

    it('is compact (at the bottom) while stills show', () => {
      open({ id: 'cam1', online: true }, 60);
      expect(overlay()!.classList.contains('stills')).toBe(false);
      liveUi.update((u) => ({ ...u, stillsShowing: true }));
      flushSync();
      expect(overlay()!.classList.contains('stills')).toBe(true);
    });

    it('is not shown for a camera known offline', () => {
      open({ id: 'cam1', online: false });
      expect(overlay()).toBeNull();
    });

    it.each([
      [0, 'The stream disconnects when you leave this page.'],
      [60, 'The stream stays connected for 1 min after you leave this page.'],
      [300, 'The stream stays connected for 5 min after you leave this page.'],
      [900, 'The stream stays connected for 15 min after you leave this page.'],
    ] as const)('names the keep-alive of %i s', (seconds, text) => {
      open({ id: 'cam1', online: true }, seconds);
      expect(target!.querySelector('[data-testid="live-connecting-note"]')!.textContent).toBe(text);
    });

    it('follows a keep-alive change in Settings, and defaults to 1 min', () => {
      open({ id: 'cam1', online: true });
      const note = () => target!.querySelector('[data-testid="live-connecting-note"]')!.textContent;
      expect(note()).toBe('The stream stays connected for 1 min after you leave this page.');
      preferences.set({ liveKeepAlive: 30 } as Preferences);
      flushSync();
      expect(note()).toBe('The stream stays connected for 30 s after you leave this page.');
    });

    describe('after 30 s without playing', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());
      const text = () => overlay()!.textContent ?? '';
      const spinner = () => overlay()!.querySelector('.spinner');

      it('turns calm: no spinner, no keep-alive line, still trying', () => {
        open({ id: 'cam1', online: true }, 60);
        vi.advanceTimersByTime(29_000);
        flushSync();
        expect(spinner()).not.toBeNull();
        vi.advanceTimersByTime(1_000);
        flushSync();
        expect(spinner()).toBeNull();
        expect(target!.querySelector('[data-testid="live-connecting-note"]')).toBeNull();
        expect(text()).toBe("The live stream isn't available right now. Still trying…");
        expect(overlay()!.getAttribute('data-state')).toBe('unavailable');
      });

      it('mentions the stills when they show', () => {
        open({ id: 'cam1', online: true }, 60);
        liveUi.update((u) => ({ ...u, stillsShowing: true }));
        vi.advanceTimersByTime(30_000);
        flushSync();
        expect(text()).toBe("The live stream isn't available right now. Still trying… Showing stills meanwhile.");
      });

      it('counts on through reconnecting, and goes once it plays', () => {
        open({ id: 'cam1', online: true }, 60);
        vi.advanceTimersByTime(20_000);
        liveUi.update((u) => ({ ...u, playerState: 'reconnecting' }));
        flushSync();
        vi.advanceTimersByTime(10_000);
        flushSync();
        expect(spinner()).toBeNull();
        liveUi.update((u) => ({ ...u, playerState: 'playing' }));
        flushSync();
        expect(overlay()).toBeNull();
      });

      it('starts over after playing: a drop gets 30 s of spinner again', () => {
        open({ id: 'cam1', online: true }, 60);
        vi.advanceTimersByTime(30_000);
        liveUi.update((u) => ({ ...u, playerState: 'playing' }));
        flushSync();
        liveUi.update((u) => ({ ...u, playerState: 'reconnecting' }));
        flushSync();
        vi.advanceTimersByTime(29_000);
        flushSync();
        expect(spinner()).not.toBeNull();
        expect(text()).toContain('Reconnecting to the live stream…');
        vi.advanceTimersByTime(1_000);
        flushSync();
        expect(spinner()).toBeNull();
      });
    });
  });
});

