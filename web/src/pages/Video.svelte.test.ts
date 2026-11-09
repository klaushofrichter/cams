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
import { liveUi } from '../lib/liveUi';

// No event stream in jsdom: the page polls instead (a test may hand it one).
const es = vi.hoisted(() => ({ stream: undefined as unknown }));
vi.mock('../lib/eventStream', async (orig) => ({ ...(await orig<typeof import('../lib/eventStream')>()), eventStream: () => es.stream }));
// jsdom has no MediaSource: players that never play.
vi.mock('../lib/mpegtsPlayer', () => ({ mpegtsPlayer: () => ({ attach() {}, load() {}, play() {}, destroy() {}, onFailure() {} }) }));
vi.mock('../lib/fmp4Player', () => ({ fmp4Player: () => ({ attach() {}, load() {}, play() {}, destroy() {}, onFailure() {} }) }));
const Video = (await import('./Video.svelte')).default;
const { createEventStream, reloadCameras } = await import('../lib/eventStream');

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
let stopRouter: (() => void) | undefined;
// One event an hour, 00:10 to 23:10 (stage 2 tests); none otherwise.
let dayEvents: ((date: string) => unknown[]) | undefined;
const hourly = (date: string) =>
  Array.from({ length: 24 }, (_, h) => {
    const hh = String(h).padStart(2, '0');
    const start = new Date(`${date}T${hh}:10:00`).toISOString();
    return { id: `${date.replace(/-/g, '')}-${hh}1000-${hh}1020`, start, end: start, durationSec: 20, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
  });

beforeEach(() => {
  resetDayCache();
  sessionStorage.clear();
  preferences.set({ defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60 });
  vi.stubGlobal('fetch', async (url: string) => {
    // Offline: the page doesn't open a live stream in jsdom.
    if (url.includes('/status')) return json({ id: 'den', online: false, error: 'camera_offline' });
    if (url.includes('/extent')) return json({ oldest: null });
    if (url.includes('/events?')) {
      const date = new URL(url, 'http://x').searchParams.get('date')!;
      return json({ events: dayEvents ? dayEvents(date) : [], downloads: 'ok' });
    }
    if (url.includes('/days?')) return json({ days: dayEvents ? ['2026-09-26', '2026-09-27'] : [] });
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
  dayEvents = undefined;
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
  // 2026-11-02: after an encoding change (the camera restarts, the stream
  // reconnects) the label kept the old size. Each start of the live stream
  // reads the camera's status (its streams) again.
  it('reads the status again whenever the live stream starts playing', async () => {
    const seen: string[] = [];
    const inner = fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => (seen.push(url), inner(url, init)));
    await open('/app/video?cam=den');
    const statusReads = () => seen.filter((u) => u.includes('/status')).length;
    const first = statusReads();
    expect(first).toBeGreaterThanOrEqual(1);
    liveUi.update((u) => ({ ...u, playerState: 'playing' }));
    await settle();
    expect(statusReads()).toBe(first + 1);
    liveUi.update((u) => ({ ...u, muted: !u.muted })); // another change while playing: no read
    await settle();
    expect(statusReads()).toBe(first + 1);
    liveUi.update((u) => ({ ...u, playerState: 'reconnecting' }));
    await settle();
    liveUi.update((u) => ({ ...u, playerState: 'playing' }));
    await settle();
    expect(statusReads()).toBe(first + 2);
    liveUi.update((u) => ({ ...u, playerState: 'connecting' }));
  });

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
    expect(here()).toBe(`/app/video?cam=den&date=2026-09-27&at=${at / 1000}&zoom=24h`); // seconds now, and the zoom (2026-11-05)
    expect(badge().dataset.mode).toBe('rec');
  });

  it('turns an old /app/live?at= link into the recording', async () => {
    const at = Date.parse('2026-09-27T10:00:00-05:00');
    await open(`/app/live?at=${at}`);
    expect(here()).toMatch(new RegExp(`^/app/video\\?cam=den&date=2026-09-27&at=${at / 1000}&zoom=24h$`));
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
    expect(here()).toMatch(/^\/app\/video\?cam=den&date=\d{4}-\d{2}-\d{2}&at=\d+&zoom=24h$/);
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

  // Stage 2 (spec 2026-10-04): landings collapse the far hours.
  const openHours = () =>
    [...target!.querySelectorAll<HTMLElement>('[data-testid="hour-group"]')]
      .filter((g) => g.querySelector('[data-testid="hour-toggle"]')!.getAttribute('aria-expanded') === 'true')
      .map((g) => Number(g.dataset.hour))
      .sort((a, b) => a - b);
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  it('a link with a time is a landing there', async () => {
    dayEvents = hourly;
    await open(`/app/video?cam=den&date=2026-09-27&at=${new Date(2026, 8, 27, 12, 30).getTime()}`);
    expect(openHours()).toEqual(range(6, 18));
  });

  it('a day picked is a landing at its first event; a card click one at the card', async () => {
    dayEvents = hourly;
    await open(`/app/video?cam=den&date=2026-09-27&at=${new Date(2026, 8, 27, 12, 30).getTime()}`);
    click('day-prev');
    await settle();
    expect(openHours()).toEqual(range(0, 6));
    (target!.querySelector('[data-testid="hour-group"][data-hour="6"] [data-testid="event-card"]') as HTMLElement).click();
    await settle();
    expect(openHours()).toEqual(range(0, 12));
  });

  it('dragging back (the playhead moving) is no landing', async () => {
    dayEvents = hourly;
    await open(`/app/video?cam=den&date=2026-09-27&at=${new Date(2026, 8, 27, 12, 30).getTime()}`);
    for (let i = 0; i < 5; i++) click('back-10');
    await settle();
    expect(openHours()).toEqual(range(6, 18));
  });
});

// Finding 23 (2026-11-08): a page open on a camera held as new (offline:
// camera_unconfirmed, stills) stayed offline and on stills after an admin's
// Confirm; only a reload brought live video. The list was re-read (#360), but
// the camera's status, which decides player or stills, was not.
describe('Video page after a held camera is confirmed', () => {
  let confirmed = false;
  let statusReads = 0;
  beforeEach(() => {
    confirmed = false;
    statusReads = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/status')) {
        statusReads++;
        return json(confirmed ? { id: 'den', online: true } : { id: 'den', online: false, error: 'camera_unconfirmed' });
      }
      if (url === '/api/cameras') return json([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true, proxyConfigured: true, ...(confirmed ? {} : { credentials: 'unconfirmed' }) }]);
      if (url.includes('/extent')) return json({ oldest: null });
      if (url.includes('/events?')) return json({ events: [], downloads: 'ok' });
      return json([]);
    });
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true, proxyConfigured: true, credentials: 'unconfirmed' }]);
  });
  afterEach(() => liveUi.update((u) => ({ ...u, status: null, playerState: 'connecting', stillsShowing: false })));

  const offline = () => target!.querySelector('[data-testid="offline-reason"]')?.textContent ?? null;
  const player = () => target!.querySelector('[data-testid="live-video"]');

  async function openHeld() {
    await open('/app/video?cam=den');
    expect(offline()).toBe("A change to the camera's connection data is waiting for an admin to confirm it.");
    expect(player()).toBeNull(); // stills only
  }

  it('confirmed on this page (the banner re-reads the list): the offline card goes and the player starts', async () => {
    await openHeld();
    const before = statusReads;
    confirmed = true;
    await reloadCameras(); // what HeldBanner does after a Confirm
    await settle();
    expect(statusReads).toBe(before + 1);
    expect(offline()).toBeNull();
    expect(player()).not.toBeNull();
  });

  it('confirmed elsewhere (another tab or session; the event stream says so): the same', async () => {
    await openHeld();
    type Fn = (e: { data: string }) => void;
    const listeners = new Map<string, Fn>();
    const source = { readyState: 1, onopen: null, onerror: null, addEventListener: (t: string, fn: Fn) => void listeners.set(t, fn), close() {} };
    const stream = createEventStream({ factory: () => source });
    confirmed = true;
    listeners.get('cameras')!({ data: '{}' }); // the server's `cameras` event once the new configuration is in use
    await settle();
    expect(offline()).toBeNull();
    expect(player()).not.toBeNull();
    stream.close();
  });

  it('a list re-read that changes nothing for a live camera keeps it live', async () => {
    confirmed = true;
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true, proxyConfigured: true }]);
    await open('/app/video?cam=den');
    expect(player()).not.toBeNull();
    const v = player();
    await reloadCameras();
    await settle();
    expect(player()).toBe(v); // same player, no restart
  });
});


// A camera that went offline for another reason (a power cut, its network:
// not a held change) came back on screen only with a reload, the Retry
// button or a change to its list entry. The page now reads its status again
// when the camera's cam-proxy reports a camera-status change or comes up
// again, and every 30 s while it is offline without such events.
describe('Video page: an offline camera comes back by itself', () => {
  let online = false;
  let statusReads = 0;
  type Fn = (e: { data: string }) => void;
  let listeners: Map<string, Fn>;
  let source: { readyState: number; onopen: (() => void) | null; onerror: (() => void) | null; addEventListener: (t: string, fn: Fn) => void; close(): void };
  beforeEach(() => {
    online = false;
    statusReads = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/status')) {
        statusReads++;
        return json(online ? { id: 'den', online: true } : { id: 'den', online: false, error: 'camera_offline' });
      }
      if (url.includes('/extent')) return json({ oldest: null });
      if (url.includes('/events?')) return json({ events: [], downloads: 'ok' });
      return json([]);
    });
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true, proxyConfigured: true }]);
    listeners = new Map();
    source = { readyState: 1, onopen: null, onerror: null, addEventListener: (t, fn) => void listeners.set(t, fn), close() {} };
  });
  afterEach(() => {
    (es.stream as { close?: () => void } | undefined)?.close?.();
    es.stream = undefined;
    vi.useRealTimers();
    liveUi.update((u) => ({ ...u, status: null, playerState: 'connecting', stillsShowing: false }));
  });

  const offline = () => target!.querySelector('[data-testid="offline-reason"]')?.textContent ?? null;
  const player = () => target!.querySelector('[data-testid="live-video"]');
  const withStream = () => {
    es.stream = createEventStream({ factory: () => source });
    source.onopen?.();
  };

  it('the proxy reports the camera online again (camera-status): the player starts', async () => {
    withStream();
    listeners.get('proxy')!({ data: JSON.stringify({ cam: 'den', up: true }) });
    await open('/app/video?cam=den');
    expect(offline()).toBe('The camera could not be reached.');
    expect(player()).toBeNull();
    const before = statusReads;
    online = true;
    listeners.get('change')!({ data: JSON.stringify({ cam: 'den', type: 'camera-status', ts: null }) });
    await settle();
    expect(statusReads).toBe(before + 1);
    expect(offline()).toBeNull();
    expect(player()).not.toBeNull();
  });

  it("another camera's camera-status change reads nothing", async () => {
    withStream();
    listeners.get('proxy')!({ data: JSON.stringify({ cam: 'den', up: true }) });
    await open('/app/video?cam=den');
    const before = statusReads;
    listeners.get('change')!({ data: JSON.stringify({ cam: 'loft', type: 'camera-status', ts: null }) });
    await settle();
    expect(statusReads).toBe(before);
  });

  it('the proxy comes up again while the camera shows offline: its status is read again', async () => {
    withStream();
    await open('/app/video?cam=den');
    expect(offline()).not.toBeNull();
    const before = statusReads;
    online = true;
    listeners.get('proxy')!({ data: JSON.stringify({ cam: 'den', up: true }) });
    await settle();
    expect(statusReads).toBe(before + 1);
    expect(player()).not.toBeNull();
  });

  it('without proxy events: every 30 s while offline, and no more once online', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await open('/app/video?cam=den');
    expect(offline()).not.toBeNull();
    const before = statusReads;
    vi.advanceTimersByTime(29_000);
    await settle();
    expect(statusReads).toBe(before);
    online = true;
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(statusReads).toBe(before + 1);
    expect(player()).not.toBeNull();
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(statusReads).toBe(before + 1); // online: no poll
  });
});
