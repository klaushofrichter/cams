// @vitest-environment jsdom
//
// The Video page's wiring (spec 2026-10-04, review of #173): the old URLs
// become /app/video…, the route sets the mode, and the mode moves the URL
// (pushed, so Back works).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameras, selectedCameraId } from '../lib/stores';
import { initRouter, navigate } from '../lib/router';
import { preferences } from '../lib/preferences';
import { resetDayCache } from '../lib/dayCache';

// No event stream in jsdom: the page polls instead.
vi.mock('../lib/eventStream', async (orig) => ({ ...(await orig<typeof import('../lib/eventStream')>()), eventStream: () => undefined }));
const Video = (await import('./Video.svelte')).default;

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
let stopRouter: (() => void) | undefined;

beforeEach(() => {
  resetDayCache();
  sessionStorage.clear();
  preferences.set({ defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60 });
  vi.stubGlobal('fetch', async (url: string) => {
    // Offline: the page doesn't open a live stream in jsdom.
    if (url.includes('/status')) return json({ id: 'den', online: false, error: 'camera_offline' });
    if (url.includes('/extent')) return json({ oldest: null });
    if (url.includes('/events?')) return json({ events: [], downloads: 'ok' });
    if (url.includes('/days?')) return json({ days: [] });
    return json([]);
  });
  cameras.set([{ id: 'den', name: 'Den', webUiUrl: null }]);
  selectedCameraId.set('den');
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  stopRouter?.();
  component = target = stopRouter = undefined;
  cameras.set([]);
  selectedCameraId.set(null);
  preferences.set(null);
  vi.unstubAllGlobals();
});

async function open(url: string) {
  history.replaceState(null, '', url);
  stopRouter = initRouter();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Video, { target, props: { pageVisible: true, tabVisible: true } });
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const here = () => location.pathname + location.search;
const badge = () => target!.querySelector('[data-testid="mode-badge"]') as HTMLElement;
const click = (id: string) => (target!.querySelector(`[data-testid="${id}"]`) as HTMLElement).click();

describe('Video page wiring', () => {
  it('rewrites /app/live to /app/video, live, in place', async () => {
    const before = history.length;
    await open('/app/live');
    expect(here()).toBe('/app/video');
    expect(history.length).toBe(before); // replaced, not pushed
    expect(badge().dataset.mode).toBe('live');
  });

  it('keeps an old live link’s camera', async () => {
    await open('/app/live?cam=den');
    expect(here()).toBe('/app/video?cam=den');
  });

  it('rewrites an old History link to /app/video at its day and time, a recording', async () => {
    const at = Date.parse('2026-09-27T10:00:00-05:00');
    await open(`/app/recordings?cam=den&date=2026-09-27&panel=history&at=${at}`);
    expect(here()).toBe(`/app/video?cam=den&date=2026-09-27&at=${at}`);
    expect(badge().dataset.mode).toBe('rec');
  });

  it('turns an old /app/live?at= link into the recording', async () => {
    const at = Date.parse('2026-09-27T10:00:00-05:00');
    await open(`/app/live?at=${at}`);
    expect(here()).toMatch(new RegExp(`^/app/video\\?cam=den&date=2026-09-27&at=${at}$`));
    expect(badge().dataset.mode).toBe('rec');
  });

  it('leaves /app/video alone', async () => {
    await open('/app/video');
    expect(here()).toBe('/app/video');
    expect(badge().dataset.mode).toBe('live');
  });

  it('a route without a position is live, one with a position a recording', async () => {
    await open('/app/video');
    navigate('/app/video?cam=den&date=2026-09-27&at=1790500000000');
    await settle();
    expect(badge().dataset.mode).toBe('rec');
    navigate('/app/video');
    await settle();
    expect(badge().dataset.mode).toBe('live');
    // A day without a time (the day picker), today's too: a recording.
    navigate(`/app/video?cam=den&date=${new Date().toLocaleDateString('en-CA')}`);
    await settle();
    expect(badge().dataset.mode).toBe('rec');
  });

  it('live → recording pushes its URL, and ⇥ pushes /app/video; Back returns', async () => {
    await open('/app/video');
    const before = history.length;
    click('back-10');
    await settle();
    expect(badge().dataset.mode).toBe('rec');
    expect(here()).toMatch(/^\/app\/video\?cam=den&date=\d{4}-\d{2}-\d{2}&at=\d+$/);
    expect(history.length).toBe(before + 1);
    const rec = here();
    click('strip-now');
    await settle();
    expect(badge().dataset.mode).toBe('live');
    expect(here()).toBe('/app/video');
    expect(history.length).toBe(before + 2);
    history.back();
    await new Promise((r) => setTimeout(r, 20));
    await settle();
    expect(here()).toBe(rec);
    expect(badge().dataset.mode).toBe('rec');
  });

  it('the REC badge is live again', async () => {
    await open('/app/video');
    click('back-10');
    await settle();
    badge().click();
    await settle();
    expect(badge().dataset.mode).toBe('live');
    expect(here()).toBe('/app/video');
  });
});
