// @vitest-environment jsdom
//
// Plan 7 review I4: the scrub preview loads a minute's sprite only once the
// pointer rests there (150 ms), so a sweep across the day doesn't fetch
// hundreds of sprites.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Timeline from './Timeline.svelte';
import { dayRange, type PreviewMinute } from '../lib/timeline';
import { preferences, type Preferences } from '../lib/preferences';
import type { EventClip } from '../lib/recordings';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  preferences.set(null);
});

const date = '2026-09-27';
const start = dayRange(date)[0];
const sprite = (minute: number): PreviewMinute => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/sprite/${minute}.jpg` });

describe('Timeline scrub preview', () => {
  it('shows the time at once and the sprite only after the pointer rests', () => {
    vi.useFakeTimers();
    const previews = [sprite(start + 600 * 60_000), sprite(start + 900 * 60_000)];
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Timeline, { target, props: { events: [], date, selectedId: null, onpick: () => undefined, onstep: () => undefined, onedge: () => undefined, previews, dayStartMs: start } });
    flushSync();
    const bar = target.querySelector('[data-testid="timeline"]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 46, right: 1440, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
    const moveTo = (min: number) => bar.dispatchEvent(new MouseEvent('pointermove', { clientX: min, bubbles: true }));
    const frame = () => target!.querySelector('[data-testid="scrub-preview"] .frame') as HTMLElement | null;
    moveTo(600); // minute 600 of the 24 h window (1 px per minute)
    flushSync();
    expect(target.querySelector('[data-testid="scrub-preview"]')).not.toBeNull();
    expect(frame()!.getAttribute('style') ?? '').not.toContain('background-image');
    vi.advanceTimersByTime(100);
    moveTo(900); // moved on before the rest: minute 600's sprite never loads
    flushSync();
    vi.advanceTimersByTime(100);
    flushSync();
    expect(frame()!.getAttribute('style') ?? '').not.toContain('/sprite/');
    vi.advanceTimersByTime(100);
    flushSync();
    expect(frame()!.getAttribute('style')).toContain(`/sprite/${start + 900 * 60_000}.jpg`);
  });
});

// Klaus, 2026-09-27: the zoom stays when switching pages; a zoomed window can
// be moved; the parts without a thumbnail look different; a camera without a
// proxy shows the event's thumbnail on hover.
const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 24, liveKeepAlive: 60 };
const ev = (id: string, hhmm: string, sec = 30): EventClip => {
  const startIso = `${date}T${hhmm}:00-05:00`;
  return { id, start: startIso, end: new Date(Date.parse(startIso) + sec * 1000).toISOString(), durationSec: sec, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
};
function render(props: Record<string, unknown>) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Timeline, { target, props: { events: [], date, selectedId: null, onpick: () => undefined, onstep: () => undefined, onedge: () => undefined, ...props } });
  flushSync();
  return target;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('Timeline zoom', () => {
  it('follows the saved preference, also when it arrives after the timeline', () => {
    render({ events: [ev('a', '15:30')], selectedId: 'a' });
    expect(q('zoom-24')!.getAttribute('aria-pressed')).toBe('true');
    preferences.set({ ...PREFS, timelineZoom: 6 });
    flushSync();
    expect(q('zoom-6')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('saves a new zoom as the preference, so the next page starts with it', async () => {
    const puts: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      puts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ...PREFS, timelineZoom: 1 }), { status: 200 });
    });
    preferences.set(PREFS);
    render({});
    q('zoom-1')!.click();
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    expect(puts).toEqual([{ timelineZoom: 1 }]);
    unmount(component!);
    target!.remove();
    render({}); // another page
    expect(q('zoom-1')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('saves picks one after another, so the last pick wins (review M8)', async () => {
    const answers: (() => void)[] = [];
    const sent: number[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      const z = JSON.parse(String(init.body)).timelineZoom;
      sent.push(z);
      return new Promise<Response>((r) => answers.push(() => r(new Response(JSON.stringify({ ...PREFS, timelineZoom: z }), { status: 200 }))));
    });
    preferences.set(PREFS);
    render({});
    q('zoom-1')!.click();
    q('zoom-6')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([1]); // the second waits for the first
    answers[0]();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(q('zoom-6')!.getAttribute('aria-pressed')).toBe('true');
    expect(sent).toEqual([1, 6]);
    answers[1]();
    await new Promise((r) => setTimeout(r, 0));
    unmount(component!);
    target!.remove();
    render({});
    expect(q('zoom-6')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Timeline window', () => {
  it('moves a zoomed window by its length, shows its range, and changes day at the edge', () => {
    const onday = vi.fn();
    preferences.set({ ...PREFS, timelineZoom: 1 });
    render({ events: [ev('a', '15:30')], selectedId: 'a', onday });
    expect(q('timeline-range')!.textContent).toBe('15:00–16:00');
    q('timeline-prev')!.click();
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('14:00–15:00');
    q('timeline-next')!.click();
    q('timeline-next')!.click();
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('16:00–17:00');
    for (let i = 0; i < 20; i++) q('timeline-prev')!.click();
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('00:00–01:00');
    expect(onday).toHaveBeenCalledWith(-1);
  });

  it('opens the previous day on its last hour after ‹ from the first', () => {
    preferences.set({ ...PREFS, timelineZoom: 1 });
    target = document.createElement('div');
    document.body.appendChild(target);
    const props = $state({ events: [ev('a', '00:10')], date, selectedId: 'a' as string | null, onpick: () => undefined, onstep: () => undefined, onedge: () => undefined,
      onday: (dir: -1 | 1) => { props.date = dir < 0 ? '2026-09-26' : '2026-09-28'; props.events = []; props.selectedId = null; return props.date; } });
    component = mount(Timeline, { target, props });
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('00:00–01:00');
    q('timeline-prev')!.click();
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('23:00–24:00');
  });

  it('forgets a day change that did not happen (review I1)', () => {
    preferences.set({ ...PREFS, timelineZoom: 1 });
    target = document.createElement('div');
    document.body.appendChild(target);
    const props = $state({ events: [ev('a', '23:30')], date, selectedId: 'a' as string | null, onpick: () => undefined, onstep: () => undefined, onedge: () => undefined,
      onday: () => null });
    component = mount(Timeline, { target, props });
    flushSync();
    q('timeline-next')!.click(); // today's last hour: nowhere to go
    flushSync();
    props.date = '2026-09-25';
    props.events = [];
    props.selectedId = null;
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('12:00–13:00');
  });

  it('keeps a moved window when the next clip is inside it, and follows one outside (review I3)', () => {
    preferences.set({ ...PREFS, timelineZoom: 6 });
    target = document.createElement('div');
    document.body.appendChild(target);
    const props = $state({ events: [ev('a', '12:00'), ev('b', '08:00'), ev('c', '18:00')], date, selectedId: 'a' as string | null, onpick: () => undefined, onstep: () => undefined, onedge: () => undefined });
    component = mount(Timeline, { target, props });
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('09:00–15:00');
    q('timeline-prev')!.click();
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('03:00–09:00');
    props.selectedId = 'b'; // 08:00, inside the moved window: it stays
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('03:00–09:00');
    props.selectedId = 'c'; // 18:00, outside: the window follows
    flushSync();
    expect(q('timeline-range')!.textContent).toBe('15:00–21:00');
  });

  it('has no window buttons at 24 h', () => {
    preferences.set(PREFS);
    render({});
    expect(q('timeline-prev')).toBeNull();
  });
});

describe('Timeline thumbnails', () => {
  it('marks where a thumbnail exists; the rest is the no-thumbnail background', () => {
    render({ events: [ev('a', '06:00', 60), ev('b', '18:00', 60)], dayStartMs: start, thumbFor: (id: string) => `/thumb/${id}.jpg` });
    expect(target!.querySelectorAll('[data-testid="timeline-thumb-span"]')).toHaveLength(2);
  });

  it('counts events as covered only when their thumbnails can be shown (review M6)', () => {
    render({ events: [ev('a', '06:00', 60)], dayStartMs: start });
    expect(target!.querySelectorAll('[data-testid="timeline-thumb-span"]')).toHaveLength(0);
  });

  it('shows the event’s own thumbnail on hover, once the pointer rests (review I4)', () => {
    vi.useFakeTimers();
    render({ events: [ev('a', '12:00', 600)], dayStartMs: start, thumbFor: (id: string) => `/thumb/${id}.jpg` });
    const bar = q('timeline')!;
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 46, right: 1440, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
    bar.dispatchEvent(new MouseEvent('pointermove', { clientX: 722, bubbles: true })); // 12:02
    flushSync();
    expect(q('scrub-preview')).not.toBeNull();
    expect(q('scrub-preview')!.querySelector('img')).toBeNull(); // not fetched while sweeping
    vi.advanceTimersByTime(200);
    flushSync();
    const img = q('scrub-preview')!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/thumb/a.jpg');
    img.dispatchEvent(new Event('error'));
    flushSync();
    expect(q('scrub-preview')!.querySelector('img')).toBeNull(); // no broken-image box
    bar.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, bubbles: true })); // 05:00, no event
    flushSync();
    expect(q('scrub-preview')).toBeNull();
  });
});

