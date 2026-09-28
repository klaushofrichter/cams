// @vitest-environment jsdom
//
// The live notification in the top bar (Klaus, 2026-09-28): "Person on Den",
// shown for a second, then fading within 0.4 s; a new event replaces it with
// a fresh timer; only the types chosen in Settings, and only with live events on.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveNotice from './LiveNotice.svelte';
import { cameras } from '../lib/stores';
import { preferences, type Preferences } from '../lib/preferences';
import type { CameraEvent } from '../lib/eventStream';

const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60, liveEvents: true, liveEventTypes: ['person', 'vehicle', 'pet', 'motion'] };
let fire: (e: CameraEvent) => void = () => undefined;
const source = { onCameraEvent: (fn: (e: CameraEvent) => void) => { fire = fn; return () => { fire = () => undefined; }; } };
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  cameras.set([{ id: 'cam1', name: 'Den', webUiUrl: null }, { id: 'cam2', name: 'cam2', webUiUrl: null }]);
  preferences.set(PREFS);
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  preferences.set(null);
  cameras.set([]);
});
function render() {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LiveNotice, { target, props: { source } });
  flushSync();
}
const notice = () => target!.querySelector('[data-testid="live-notice"]') as HTMLElement | null;
const at = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
};

describe('LiveNotice', () => {
  it('shows "Person on Den" for a second, then fades within 0.4 s', async () => {
    render();
    fire({ cam: 'cam1', kind: 'person', ts: 1 });
    flushSync();
    expect(notice()!.textContent!.trim()).toBe('Person on Den');
    expect(notice()!.classList.contains('fading')).toBe(false);
    await at(1000);
    expect(notice()!.classList.contains('fading')).toBe(true);
    await at(400);
    expect(notice()).toBeNull();
  });

  it('replaces the notice and restarts the timer when another event comes', async () => {
    render();
    fire({ cam: 'cam1', kind: 'person', ts: 1 });
    await at(700);
    fire({ cam: 'cam2', kind: 'motion', ts: 2 });
    flushSync();
    expect(notice()!.textContent!.trim()).toBe('Motion on cam2');
    await at(900);
    expect(notice()!.classList.contains('fading')).toBe(false); // the new timer
    await at(500);
    expect(notice()).toBeNull();
  });

  it('only shows the chosen types, and nothing with live events off', async () => {
    preferences.set({ ...PREFS, liveEventTypes: ['person'] });
    render();
    fire({ cam: 'cam1', kind: 'motion', ts: 1 });
    flushSync();
    expect(notice()).toBeNull();
    preferences.set({ ...PREFS, liveEvents: false });
    flushSync();
    fire({ cam: 'cam1', kind: 'person', ts: 2 });
    flushSync();
    expect(notice()).toBeNull();
  });
});
