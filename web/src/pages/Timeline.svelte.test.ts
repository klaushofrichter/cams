// @vitest-environment jsdom
//
// Final review I5: a live change on today's Timeline refreshes the tiles in
// place; it must not close the still being looked at or clear the page.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameras, selectedCameraId } from '../lib/stores';
import { loadViewPoint, saveViewPoint } from '../lib/timeline';
import { loadCursor, localDate } from '../lib/recordings';

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
    // The page opens that minute and its still at the shared cursor.
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

  it('calls another 404 "not reachable", not "keeps no stills" (issue #76)', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', async (url: string) => (url.includes('/previews?') ? new Response('{"error":"not found"}', { status: 404 }) : json({ events: [] })));
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
    selectedCameraId.set('den');
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target });
    for (let i = 0; i < 5; i++) await tick();
    flushSync();
    expect(target.textContent).toContain('not reachable');
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

  // A still still loading when the day changes must not open on the new day.
  it('drops a still that finishes loading after the day changed', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/previews?')) return json([{ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/x/${minute}.jpg` }]);
      if (url.includes('/stills?')) {
        await held;
        return json([minute, minute + 1000]);
      }
      if (url.includes('/events?')) return json({ events: [] });
      return json({});
    });
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
    selectedCameraId.set('den');
    sessionStorage.clear();
    history.replaceState(null, '', '/app/timeline');
    saveViewPoint('den', minute);
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target });
    for (let i = 0; i < 8; i++) await tick();
    flushSync();
    const day = target.querySelector('[data-testid="timeline-day"]') as HTMLInputElement;
    day.value = '2020-01-01';
    day.dispatchEvent(new Event('input'));
    flushSync();
    release!();
    for (let i = 0; i < 8; i++) await tick();
    flushSync();
    expect(target.querySelector('[data-testid="timeline-still"]')).toBeNull();
    expect(new URLSearchParams(location.search).get('t')).toBeNull();
  });

  // Klaus, 2026-09-29: the Timeline shares the cursor with History and Live.
  describe('shared cursor', () => {
    const m0 = minute - 60_000; // two minutes with sprites: minute-1 and minute
    const sprite = (x: number) => ({ minute: x, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/x/${x}.jpg` });
    // opts.missing: tiles missing from every sprite; opts.hold: awaited before each /stills answer.
    async function open(vp?: number | null, sprites: number[] = [m0, minute], events: unknown[] = [], opts: { missing?: number[]; hold?: () => Promise<void> } = {}) {
      sessionStorage.clear();
      history.replaceState(null, '', '/app/timeline');
      if (vp !== undefined) saveViewPoint('den', vp);
      vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.includes('/previews?')) return json(sprites.map(sprite).map((x) => ({ ...x, present: x.present.map((p, i) => p && !opts.missing?.includes(i)) })));
        if (url.includes('/stills?')) {
          await opts.hold?.();
          const from = Number(new URL(url, 'http://x').searchParams.get('from'));
          return json(Array.from({ length: 60 }, (_, i) => from + i * 1000));
        }
        // The cards on their own day only (the page also asks for its neighbours).
        if (url.includes('/events?')) return json({ events: new URL(url, 'http://x').searchParams.get('date') === localDate(new Date(sprites[0])) ? events : [] });
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

    it('opens that minute and its still at the History time', async () => {
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

    const q = (sel: string) => target!.querySelector(sel);
    const qa = (sel: string) => [...target!.querySelectorAll(sel)] as HTMLElement[];

    it('a minute click opens its seconds under its hour, and stays on the page', async () => {
      await open();
      qa('[data-testid="timeline-minute"]')[1].click();
      flushSync();
      expect(location.pathname).toBe('/app/timeline');
      const view = q('[data-testid="timeline-minute-view"]');
      expect(view?.closest('[data-testid="timeline-hour"]')?.contains(qa('[data-testid="timeline-minute"]')[1])).toBe(true);
      expect(qa('[data-testid="timeline-second"]')).toHaveLength(60);
      expect(q('[data-testid="timeline-still"]')).toBeNull();
    });

    it('a second click opens its still and moves the shared cursor', async () => {
      await open();
      qa('[data-testid="timeline-minute"]')[0].click();
      flushSync();
      qa('[data-testid="timeline-second"]')[18].click();
      for (let i = 0; i < 4; i++) await tick();
      flushSync();
      expect(still()).toBe(`/api/cameras/den/stills/${m0 + 18_000}.jpg`);
      expect(loadViewPoint('den')).toEqual({ at: m0 + 18_000 });
      expect(loadCursor()?.cursor.at).toBe(m0 + 18_000);
    });

    it('the arrow keys step the minute within its hour only', async () => {
      const h = new Date();
      h.setHours(10, 58, 0, 0);
      const a = h.getTime();
      await open(a + 5000, [a, a + 60_000, a + 120_000]); // 10:58, 10:59, 11:00
      const active = () => q('[data-testid="timeline-minute"].active')?.getAttribute('data-minute');
      expect(active()).toBe(String(a));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true })); // Alt+→ is the browser's
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true }));
      flushSync();
      expect(active()).toBe(String(a));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      flushSync();
      expect(active()).toBe(String(a + 60_000));
      expect(q('[data-testid="timeline-still"]')).toBeNull(); // a new minute starts without a still
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      flushSync();
      expect(active()).toBe(String(a + 60_000)); // 11:00 is another hour
    });

    it('an analysed second shows ✦ and opens its still with Vision’s boxes', async () => {
      const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
      const card = { id: 'c1', start: new Date(m0 + 5000).toISOString(), end: new Date(m0 + 40_000).toISOString(), triggers: ['person', 'motion'], durationSec: 35, sizeSub: 1, sizeMain: 1,
        analysis: { best: { person: { score: 0.84, subtype: 'person' } }, notConfirmed: [], stills: [{ eventId: 7, stillTs: m0 + 20_000, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }] }] } };
      await open(undefined, [m0, minute], [card]);
      const tile = qa('[data-testid="timeline-minute"]')[0];
      expect(tile.classList.contains('analysed')).toBe(true);
      tile.click();
      flushSync();
      // The camera's kinds in the app's order: Motion first (Klaus, 2026-10-01).
      expect(q('[data-testid="timeline-minute-events"]')?.textContent).toMatch(/^Motion, Person /);
      const second = qa('[data-testid="timeline-second"]')[20];
      expect(second.classList.contains('analysed')).toBe(true);
      expect(second.textContent).toContain('✦');
      second.click();
      flushSync();
      expect(still()).toBe(`/api/cameras/den/stills/${m0 + 20_000}.jpg`);
      expect(qa('[data-testid="timeline-boxes"] rect')).toHaveLength(1);
      expect(q('[data-testid="timeline-box-label"]')?.textContent).toBe('Person 84%');
      expect(q('[data-testid="timeline-open-history"]')?.getAttribute('href')).toBe(`/app/recordings?cam=den&panel=history&at=${m0 + 20_000}`);
    });

    const analysedCard = () => ({ id: 'c1', start: new Date(m0 + 5000).toISOString(), end: new Date(m0 + 40_000).toISOString(), triggers: ['person'], durationSec: 35, sizeSub: 1, sizeMain: 1,
      analysis: { best: { person: { score: 0.84, subtype: 'person' } }, notConfirmed: [], stills: [{ eventId: 7, stillTs: m0 + 20_000, summary: [{ category: 'person', subtype: 'person', score: 0.84, box: { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 } }] }] } });

    it('an analysed second opens even when its sprite tile is missing', async () => {
      await open(undefined, [m0, minute], [analysedCard()], { missing: [20] });
      qa('[data-testid="timeline-minute"]')[0].click();
      flushSync();
      const second = qa('[data-testid="timeline-second"]')[20];
      expect((second as HTMLButtonElement).disabled).toBe(false);
      second.click();
      flushSync();
      expect(still()).toBe(`/api/cameras/den/stills/${m0 + 20_000}.jpg`);
      expect(qa('[data-testid="timeline-boxes"] rect')).toHaveLength(1);
    });

    it('opened at an analysed still, shows it with Vision’s boxes', async () => {
      await open(m0 + 20_000, [m0, minute], [analysedCard()]);
      expect(still()).toBe(`/api/cameras/den/stills/${m0 + 20_000}.jpg`);
      expect(qa('[data-testid="timeline-boxes"] rect')).toHaveLength(1);
    });

    it('Escape drops a still that is still loading', async () => {
      let calls = 0;
      let release: (() => void) | undefined;
      const held = new Promise<void>((r) => (release = r));
      await open(m0 + 5000, [m0, minute], [], { hold: () => (++calls === 1 ? Promise.resolve() : held) });
      expect(still()).toBe(`/api/cameras/den/stills/${m0 + 5000}.jpg`);
      qa('[data-testid="timeline-second"]')[30].click(); // its still is held
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      flushSync();
      expect(still()).toBeNull();
      expect(q('[data-testid="timeline-minute-view"]')).not.toBeNull(); // the first Escape keeps the minute
      release!();
      for (let i = 0; i < 4; i++) await tick();
      flushSync();
      expect(still()).toBeNull();
    });
  });
});
