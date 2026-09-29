// @vitest-environment jsdom
//
// Final review I5: a live change on today's Timeline refreshes the tiles in
// place; it must not close the still being looked at or clear the page.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameras, selectedCameraId } from '../lib/stores';
import { loadViewPoint, saveViewPoint } from '../lib/timeline';
import { loadCursor } from '../lib/recordings';

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
    // The viewer opens at the shared cursor (a tile click goes to History since 2026-09-29).
    sessionStorage.clear();
    history.replaceState(null, '', '/app/timeline');
    saveViewPoint('den', minute);
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target });
    for (let i = 0; i < 8; i++) await tick();
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

  // Issue #38 items.
  it('marks events from the neighbouring camera days too (another time zone)', async () => {
    const asked: string[] = [];
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/previews?')) return json([{ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/x/${minute}.jpg` }]);
      if (url.includes('/events?')) {
        asked.push(new URL(url, 'http://x').searchParams.get('date')!);
        return json({ events: [] });
      }
      return json({});
    });
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
    selectedCameraId.set('den');
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target });
    for (let i = 0; i < 5; i++) await tick();
    expect(asked).toHaveLength(3); // the day and its neighbours
  });

  it('says the proxy keeps no stills, instead of "not reachable"', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', async (url: string) => (url.includes('/previews?') ? new Response('{"error":"stills_disabled"}', { status: 404 }) : json({ events: [] })));
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
    selectedCameraId.set('den');
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target });
    for (let i = 0; i < 5; i++) await tick();
    flushSync();
    expect(target.textContent).toContain("keeps no stills");
  });

  // 2026-09-29: sprites refused (429 after a burst) stayed empty for good.
  it('retries a sprite that failed to load, and shows it once it loads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.stubGlobal('IntersectionObserver', class {
        constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {}
        observe() { queueMicrotask(() => this.cb([{ isIntersecting: true }])); }
        disconnect() {}
      });
      const tries = new Map<string, number>();
      vi.stubGlobal('Image', class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(v: string) {
          const n = (tries.get(v) ?? 0) + 1;
          tries.set(v, n);
          queueMicrotask(() => (n === 1 ? this.onerror?.() : this.onload?.()));
        }
      });
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.includes('/previews?')) return json([{ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/x/${minute}.jpg` }]);
        if (url.includes('/events?')) return json({ events: [] });
        return json({});
      });
      cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
      selectedCameraId.set('den');
      target = document.createElement('div');
      document.body.appendChild(target);
      component = mount(Timeline, { target });
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
      flushSync();
      const img = () => target!.querySelector('[data-testid="timeline-minute"] .img') as HTMLElement;
      expect(tries.get(`/x/${minute}.jpg`)).toBe(1);
      expect(img().getAttribute('style') ?? '').not.toContain('background-image'); // failed: empty for now
      await vi.advanceTimersByTimeAsync(3500);
      flushSync();
      expect(tries.get(`/x/${minute}.jpg`)).toBe(2);
      expect(img().getAttribute('style')).toContain(`/x/${minute}.jpg`);
    } finally {
      vi.useRealTimers();
    }
  });

  // Klaus, 2026-09-29: the Timeline shares the cursor with History and Live.
  describe('shared cursor', () => {
    const m0 = minute - 60_000; // two minutes with sprites: minute-1 and minute
    const sprite = (x: number) => ({ minute: x, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/x/${x}.jpg` });
    async function open(vp?: number | null) {
      sessionStorage.clear();
      history.replaceState(null, '', '/app/timeline');
      if (vp !== undefined) saveViewPoint('den', vp);
      vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.includes('/previews?')) return json([sprite(m0), sprite(minute)]);
        if (url.includes('/stills?')) {
          const from = Number(new URL(url, 'http://x').searchParams.get('from'));
          return json(Array.from({ length: 60 }, (_, i) => from + i * 1000));
        }
        if (url.includes('/events?')) return json({ events: [] });
        return json({});
      });
      cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
      selectedCameraId.set('den');
      target = document.createElement('div');
      document.body.appendChild(target);
      component = mount(Timeline, { target });
      for (let i = 0; i < 8; i++) await tick();
      flushSync();
    }
    const still = () => target!.querySelector('[data-testid="timeline-still"]')?.getAttribute('src') ?? null;

    it('opens the viewer on the History time it was left at', async () => {
      await open(m0 + 17_000);
      expect(still()).toBe(`/api/cameras/den/stills/${m0 + 17_000}.jpg`);
    });

    it('coming from Live, opens the newest minute', async () => {
      await open(null);
      const ts = Number(/stills\/(\d+)\.jpg/.exec(still()!)![1]);
      expect(ts).toBeGreaterThanOrEqual(minute); // in the newest minute
      expect(ts).toBeLessThan(minute + 60_000);
    });

    it('opens nothing without a view point for the camera', async () => {
      await open();
      expect(still()).toBeNull();
    });

    it('a tile click goes to History at that time', async () => {
      await open();
      (target!.querySelectorAll('[data-testid="timeline-minute"]')[1] as HTMLButtonElement).click();
      flushSync();
      expect(location.pathname).toBe('/app/recordings');
      const q = new URLSearchParams(location.search);
      expect(q.get('panel')).toBe('history');
      expect(Number(q.get('at'))).toBe(minute);
      expect(loadViewPoint('den')).toEqual({ at: minute });
    });

    it('a step in the viewer moves the shared cursor', async () => {
      await open(m0 + 17_000);
      (target!.querySelector('[aria-label="Next second"]') as HTMLButtonElement).click();
      for (let i = 0; i < 4; i++) await tick();
      flushSync();
      expect(loadViewPoint('den')).toEqual({ at: m0 + 18_000 });
      expect(loadCursor()?.cursor.at).toBe(m0 + 18_000);
    });
  });
});
