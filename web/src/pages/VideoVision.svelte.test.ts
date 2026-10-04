// @vitest-environment jsdom
//
// An open Video page follows a new analysis or still check of the day it
// shows, even a past one (Klaus, 2026-10-04: a Timeline check confirmed a
// pet, and the Video page's card said "Vision: not confirmed" until a
// reload). Through the app's real event stream, with a fake EventSource.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameras, selectedCameraId } from '../lib/stores';
import { initRouter } from '../lib/router';
import { preferences } from '../lib/preferences';
import { resetDayCache } from '../lib/dayCache';
import { eventStream } from '../lib/eventStream';
import Video from './Video.svelte';

class FakeSource {
  static last: FakeSource | undefined;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private fns = new Map<string, ((e: { data: string }) => void)[]>();
  constructor() {
    FakeSource.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.fns.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  close() {
    this.readyState = 2;
  }
}

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const DATE = '2026-10-03';
const START = new Date(`${DATE}T21:21:56`).getTime();
const AT = START + 11_000;
const card = (analysis: unknown, thumb: string) => ({
  id: '20261003-212156-212227', start: new Date(START).toISOString(), end: new Date(START + 31_000).toISOString(), durationSec: 31, triggers: ['pet'], sizeSub: 1, sizeMain: 1, analysis, thumb,
});
const notConfirmed = { best: {}, notConfirmed: ['pet'], stills: [{ eventId: 7, kind: 'pet', stillTs: START + 2000, summary: [] }] };
const confirmed = { best: { pet: { score: 0.63, subtype: 'dog' } }, notConfirmed: [], stills: [...notConfirmed.stills, { eventId: 0, kind: 'check', checkId: 12, stillTs: AT, summary: [{ category: 'pet', subtype: 'dog', score: 0.63, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }] }] };

let checked = false;
let eventsCalls = 0;
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
let stopRouter: (() => void) | undefined;

beforeEach(() => {
  resetDayCache();
  sessionStorage.clear();
  checked = false;
  eventsCalls = 0;
  vi.stubGlobal('EventSource', FakeSource);
  preferences.set({ defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60, liveEvents: true });
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/status')) return json({ id: 'den', online: false, error: 'camera_offline' });
    if (url.includes('/extent')) return json({ oldest: null });
    if (url.includes('/events?')) {
      eventsCalls++;
      const date = new URL(url, 'http://x').searchParams.get('date');
      return json({ events: date === DATE ? [checked ? card(confirmed, 'c12') : card(notConfirmed, 'a7')] : [], downloads: 'proxy-recordings' });
    }
    if (url.includes('/days?')) return json({ days: [DATE] });
    return json([]);
  });
  cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true, proxyConfigured: true } as never]);
  selectedCameraId.set('den');
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  stopRouter?.();
  component = target = stopRouter = undefined;
  preferences.set({ defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60, liveEvents: false });
  eventStream(); // closes the shared stream
  cameras.set([]);
  selectedCameraId.set(null);
  preferences.set(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) {
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const cardEl = () => target!.querySelector<HTMLElement>('[data-testid="event-card"]')!;
const badgeTexts = () => [...target!.querySelectorAll<HTMLElement>('[data-testid="vision-badge"]')].map((b) => b.textContent);

describe('Video page cards after a new analysis or still check', () => {
  it('a still check of the past day it shows: the badge and the thumbnail change in place, the card stays selected', async () => {
    history.replaceState(null, '', `/app/video?cam=den&date=${DATE}&at=${START + 5000}`);
    stopRouter = initRouter();
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Video, { target, props: { pageVisible: true, tabVisible: true } });
    await settle();
    expect(badgeTexts()).toEqual(['✦ Vision: not confirmed']);
    expect(target!.querySelector<HTMLImageElement>('img[data-testid="event-thumb"]')?.getAttribute('src')).toContain('a7');
    cardEl().click();
    await settle();
    expect(cardEl().getAttribute('aria-current')).toBe('true');
    const calls = eventsCalls;
    checked = true;
    FakeSource.last!.emit('change', { cam: 'den', type: 'still-check', ts: AT });
    await new Promise((r) => setTimeout(r, 1500)); // debounced
    await settle();
    expect(badgeTexts()).toEqual(['✦ Vision 63%']);
    expect(eventsCalls).toBe(calls + 1);
    expect(cardEl().getAttribute('aria-current')).toBe('true');
    // The thumbnail of the confirming still (#180): a new image request.
    expect(target!.querySelector<HTMLImageElement>('img[data-testid="event-thumb"]')?.getAttribute('src')).toContain('c12');
  });

  it('another camera or another day: nothing is fetched', async () => {
    history.replaceState(null, '', `/app/video?cam=den&date=${DATE}`);
    stopRouter = initRouter();
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Video, { target, props: { pageVisible: true, tabVisible: true } });
    await settle();
    const calls = eventsCalls;
    FakeSource.last!.emit('change', { cam: 'yard', type: 'analysis', ts: AT });
    FakeSource.last!.emit('change', { cam: 'den', type: 'still-check', ts: AT - 3 * 86_400_000 });
    await new Promise((r) => setTimeout(r, 1500));
    await settle();
    expect(eventsCalls).toBe(calls);
  });
});
