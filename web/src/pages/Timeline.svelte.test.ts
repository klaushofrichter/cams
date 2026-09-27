// @vitest-environment jsdom
//
// Final review I5: a live change on today's Timeline refreshes the tiles in
// place; it must not close the still being looked at or clear the page.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameras, selectedCameraId } from '../lib/stores';

let fireChange: (() => void) | undefined;
vi.mock('../lib/eventStream', () => ({
  eventStream: () => ({
    watch: (_cam: () => string, onChange: () => void) => {
      fireChange = onChange;
      return () => undefined;
    },
    streaming: () => true,
  }),
}));

const Timeline = (await import('./Timeline.svelte')).default;
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  cameras.set([]);
  vi.unstubAllGlobals();
});

const minute = (() => {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() - 5);
  return d.getTime();
})();
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Timeline', () => {
  it('keeps the open still and the tiles when today refreshes', async () => {
    let previewCalls = 0;
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/previews?')) {
        previewCalls++;
        return json([{ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/x/${minute}.jpg` }]);
      }
      if (url.includes('/stills?')) return json([minute, minute + 1000]);
      if (url.includes('/events?')) return json({ events: [] });
      return json({});
    });
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
    selectedCameraId.set('den');
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target });
    for (let i = 0; i < 5; i++) await tick();
    flushSync();
    (target.querySelector('[data-testid="timeline-minute"]') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await tick();
    flushSync();
    expect(target.querySelector('[data-testid="timeline-still"]')).not.toBeNull();

    fireChange!();
    flushSync();
    // Mid-refresh and after it: still open, tiles still there.
    expect(target.querySelector('[data-testid="timeline-still"]')).not.toBeNull();
    expect(target.querySelectorAll('[data-testid="timeline-minute"]').length).toBe(1);
    for (let i = 0; i < 5; i++) await tick();
    flushSync();
    expect(previewCalls).toBe(2);
    expect(target.querySelector('[data-testid="timeline-still"]')).not.toBeNull();
    expect(target.querySelectorAll('[data-testid="timeline-minute"]').length).toBe(1);
  });
});
