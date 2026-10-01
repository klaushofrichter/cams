// web/src/components/LivePanel.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LivePanel from './LivePanel.svelte';
import { liveUi } from '../lib/liveUi';
import { get } from 'svelte/store';
import { ICONS } from '../lib/icons';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
});
const ev = { id: '20260928-091953-092013', start: new Date(Date.now() - 12 * 60_000).toISOString(), end: new Date(Date.now() - 11 * 60_000).toISOString(), durationSec: 20, triggers: ['motion' as const], sizeSub: 1, sizeMain: 1 };
function render(extra: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LivePanel, { target, props: { camera: { id: 'cam2', name: 'cam2', webUiUrl: null }, recent: [ev], pending: [], onplay: vi.fn(), proxyInfo: null, ...extra } });
  flushSync();
  return target;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('LivePanel', () => {
  it('names a simulated camera, its model and streams', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: 'cam-sim', streams: { main: { codec: 'h265', width: 4512, height: 2512, fps: 20 }, sub: { codec: 'h264', width: 896, height: 512, fps: 10 } } } }));
    render();
    expect(q('live-camera-kind')!.textContent).toBe('Simulated camera');
    expect(q('live-camera-model')!.textContent).toContain('RLC-1224A');
    expect(q('live-camera-streams')!.textContent).toContain('H.265 4512×2512 @20');
  });

  it('shows the latest event with how long ago, and plays it on click', () => {
    const onplay = vi.fn();
    render({ onplay });
    expect(q('live-latest-ago')!.textContent).toBe('12 minutes ago');
    q('live-latest')!.click();
    expect(onplay).toHaveBeenCalledWith(ev);
  });

  // Klaus, 2026-09-29: up to five, newest on top.
  const evAt = (minAgo: number) => ({ ...ev, id: `e${minAgo}`, start: new Date(Date.now() - minAgo * 60_000).toISOString() });
  const all = (id: string) => [...target!.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
  it('lists up to five recent events, newest first', () => {
    const onplay = vi.fn();
    render({ recent: [1, 2, 3, 4, 5, 6, 7].map(evAt), onplay });
    const rows = all('live-latest');
    expect(rows).toHaveLength(5);
    expect(all('live-latest-ago').map((x) => x.textContent)).toEqual(['1 minute ago', '2 minutes ago', '3 minutes ago', '4 minutes ago', '5 minutes ago']);
    rows[2].click();
    expect(onplay).toHaveBeenCalledWith(expect.objectContaining({ id: 'e3' }));
    expect(q('live-no-events')).toBeNull();
  });

  it('puts a recording in progress on top, within the five', () => {
    render({ recent: [1, 2, 3, 4, 5].map(evAt), pending: [{ kind: 'person', ts: Date.now() }] });
    const recent = q('live-recent')!;
    expect(recent.firstElementChild!.nextElementSibling).toBe(q('live-latest-pending'));
    expect(q('live-latest-pending')!.textContent).toContain('recording…');
    expect(all('live-latest')).toHaveLength(4);
  });

  it('shows events of one recording as one row (Klaus, 2026-09-30)', () => {
    const now = Date.now();
    render({ recent: [1, 2, 3, 4, 5].map(evAt), pending: [{ kind: 'motion', ts: now - 8_000 }, { kind: 'person', ts: now - 2_000 }] });
    const rows = all('live-latest-pending');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Motion, Person · recording…'); // Motion first (Klaus, 2026-10-01)
    expect(all('live-latest')).toHaveLength(4);
  });

  it('lists a recent event’s kinds Motion first, as History does (Klaus, 2026-10-01)', () => {
    render({ recent: [{ ...ev, triggers: ['person', 'motion'] }] });
    expect(q('live-latest-kinds')!.textContent).toBe('Motion, Person');
  });

  it('adds Vision badges to a recent event, and no space when there is no analysis', () => {
    render();
    expect(target!.querySelectorAll('[data-testid="vision-badge"]')).toHaveLength(0);
    const wrap = target!.querySelector('.badges');
    expect(wrap).toBeNull();
    unmount(component!);
    target!.remove();
    const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const analysis = { best: { pet: { score: 0.7, subtype: 'dog' } }, notConfirmed: [], stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'pet' as const, subtype: 'dog', score: 0.7, box }] }] };
    render({ recent: [{ ...ev, analysis }] });
    const badge = q('vision-badge')!;
    expect(badge.textContent).toBe('+ Pet 70%');
    expect(target!.querySelector('.badges')!.contains(badge)).toBe(true);
  });

  it('a Vision badge opens its dialog and does not play the event; the rest of the row still plays', () => {
    const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const analysis = { best: { pet: { score: 0.7, subtype: 'dog' } }, notConfirmed: [], stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'pet' as const, subtype: 'dog', score: 0.7, box }] }] };
    const onplay = vi.fn();
    render({ recent: [{ ...ev, analysis }], onplay });
    q('vision-badge')!.click();
    flushSync();
    expect(onplay).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="vision-dialog"]')).not.toBeNull();
    expect((document.querySelector('[data-testid="timeline-still"]') as HTMLImageElement).getAttribute('src')).toBe('/api/cameras/cam2/stills/1.jpg');
    (document.querySelector('[data-testid="vision-dialog-close"]') as HTMLElement).click();
    flushSync();
    q('live-latest')!.click();
    expect(onplay).toHaveBeenCalledTimes(1);
  });

  // Issue #113: no button in a button; the row's button names the event.
  it('puts the badges beside the row’s button, after it in keyboard order', () => {
    const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const analysis = { best: { pet: { score: 0.7, subtype: 'dog' } }, notConfirmed: [], stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'pet' as const, subtype: 'dog', score: 0.7, box }] }] };
    render({ recent: [{ ...ev, triggers: ['person', 'motion'], analysis }] });
    const row = q('live-latest')!;
    expect(row.querySelector('button, [role="button"]')).toBeNull();
    expect(row.textContent!.trim()).toMatch(/^Motion, Person, \d{2}:\d{2}:\d{2}, 12 minutes ago$/);
    const order = [...q('live-recent')!.querySelectorAll('button, [tabindex]')].map((b) => b.getAttribute('data-testid'));
    expect(order).toEqual(['live-latest', 'vision-badge']);
  });

  it('says so when there are no events', () => {
    render({ recent: [] });
    expect(q('live-recent')!.textContent).toContain('Most recent events');
    expect(q('live-no-events')!.textContent).toBe('No events today');
  });

  it('shows the offline banner with Retry', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: false, error: 'camera_offline' } }));
    render();
    expect(q('offline-reason')!.textContent).toBe('The camera could not be reached.');
    expect(q('retry')).not.toBeNull();
    expect(get(liveUi).status?.online).toBe(false);
  });

  // Final review: the panel works without the live stream (LiveBox not mounted).
  it('Retry checks the camera again without the live stream', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: 'cam2', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: null, streams: { main: null, sub: null } }), { status: 200 });
    });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: false, error: 'camera_offline' }, checking: false }));
    render();
    q('retry')!.click();
    await vi.waitFor(() => expect(get(liveUi).status?.online).toBe(true));
    expect(urls).toContain('/api/cameras/cam2/status');
    vi.unstubAllGlobals();
  });

  it('Snapshot fetches the camera’s snapshot without the live stream', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response('x', { status: 500 });
    });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true }, snapshotError: '' }));
    render();
    q('snapshot')!.click();
    await vi.waitFor(() => expect(get(liveUi).snapshotError).not.toBe(''));
    expect(urls.some((u) => u.includes('/cam2/snapshot'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('mute toggles without the live stream', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true }, muted: true }));
    render();
    q('mute-toggle')!.click();
    expect(get(liveUi).muted).toBe(false);
  });

  it('puts the controls above the most recent event, which has a title (Klaus, 2026-09-28)', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render();
    const controls = q('live-controls')!;
    const recent = q('live-recent')!;
    expect(controls.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recent.textContent).toContain('Most recent events');
    expect(recent.contains(q('live-latest'))).toBe(true);
  });

  // Issue #69 items.
  it('names the simulator with its version, and says since when a camera is offline', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: false, error: 'camera_offline', simulator: 'cam-sim 2026.09.29.1', offlineSince: Date.now() - 12 * 60_000 } }));
    render();
    expect(q('live-camera-kind')!.textContent).toBe('Simulated camera');
    expect(q('live-camera-simulator')!.textContent).toBe('cam-sim 2026.09.29.1');
    expect(q('live-offline-since')!.textContent).toContain('12 minutes ago');
  });

  it('shows the cam-proxy state even without a web link', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render({ proxyInfo: { reachable: false, webUrl: null } });
    expect(q('live-proxy-state')!.textContent).toBe('cam-proxy: not available');
    expect(q('live-proxy-link')).toBeNull();
  });

  it('says the stream is paused while the tab is hidden', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true }, playerState: 'connecting' }));
    render({ paused: true });
    expect(q('live-state')!.textContent!.trim()).toBe('Paused while the tab is hidden');
  });

  // Klaus, 2026-09-29: icons only, with tooltips; SD/4K.
  it('shows the controls as icons with tooltips', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true }, muted: true, hevc: true, quality: 'sub', snapshotBusy: false }));
    render();
    expect(q('mute-toggle')!.textContent!.trim()).toBe('');
    expect(q('mute-toggle')!.title).toBe('Muted, click to unmute');
    expect(q('mute-toggle')!.getAttribute('aria-label')).toBe('Muted, click to unmute');
    expect(q('snapshot')!.textContent!.trim()).toBe('');
    expect(q('snapshot')!.title).toBe('Save a snapshot');
    expect(q('quality-toggle')!.textContent!.trim()).toBe('SD');
    expect(q('quality-toggle')!.title).toBe('Switch to 4K');
    liveUi.update((u) => ({ ...u, muted: false, quality: 'main' }));
    flushSync();
    expect(q('mute-toggle')!.title).toBe('Sound on, click to mute');
    expect(q('quality-toggle')!.textContent!.trim()).toBe('4K');
    expect(q('quality-toggle')!.title).toBe('Switch to SD');
  });

  // The camera's manual light (WhiteLed.state), Klaus 2026-09-29.
  it('shows the light and switches it', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    let on = false;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (init?.method === 'PUT') on = JSON.parse(init.body as string).on;
      return new Response(JSON.stringify({ on }), { status: 200 });
    });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render();
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    expect(q('light-toggle')!.getAttribute('aria-pressed')).toBe('false');
    expect(q('light-toggle')!.title).toBe('Light is off, click to turn on');
    q('light-toggle')!.click();
    await vi.waitFor(() => expect(q('light-toggle')!.getAttribute('aria-pressed')).toBe('true'));
    expect(q('light-toggle')!.title).toBe('Light is on, click to turn off');
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/api/cameras/cam2/light', body: '{"on":true}' });
    expect(calls[0]).toMatchObject({ url: '/api/cameras/cam2/light', method: 'GET' });
    vi.unstubAllGlobals();
  });

  it('hides the light when the camera has none', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"camera_error"}', { status: 502 }));
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render();
    await new Promise((r) => setTimeout(r, 20));
    flushSync();
    expect(q('light-toggle')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('does not ask for the light while the tab is hidden', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response('{"on":false}', { status: 200 });
    });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render({ paused: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(urls.filter((u) => u.endsWith('/light'))).toEqual([]);
    vi.unstubAllGlobals();
  });

  // Klaus, 2026-09-29: one line, "connected" is the link.
  it('shows a reachable cam-proxy as "connected", which is the link', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render({ proxyInfo: { reachable: true, webUrl: 'https://proxy.example/' } });
    expect(q('live-proxy-state')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('cam-proxy: connected');
    const link = q('live-proxy-link') as HTMLAnchorElement;
    expect(link.textContent).toBe('connected');
    expect(link.href).toBe('https://proxy.example/');
    expect(q('live-proxy-state')!.contains(link)).toBe(true);
  });

  it('shows "connected" without a link when the proxy has no web page', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render({ proxyInfo: { reachable: true, webUrl: null } });
    expect(q('live-proxy-state')!.textContent!.trim()).toBe('cam-proxy: connected');
    expect(q('live-proxy-link')).toBeNull();
  });

  // Klaus, 2026-09-29: one colour; rays when on. The camera is slow, so the
  // button waits up to 2 s for the new state, which blocks a double click.
  function lightServer(opts: { putDelayMs: number }) {
    let on = false;
    const puts: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(init.body as string);
        await new Promise((r) => setTimeout(r, opts.putDelayMs));
        on = JSON.parse(init.body as string).on;
      }
      return new Response(JSON.stringify({ on }), { status: 200 });
    });
    return puts;
  }
  const icon = () => q('light-toggle')!.querySelector('path')!.getAttribute('d');

  it('draws the light as a plain bulb when off and with rays when on', async () => {
    lightServer({ putDelayMs: 0 });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render();
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    expect(icon()).toBe(ICONS.light);
    q('light-toggle')!.click();
    await vi.waitFor(() => expect(icon()).toBe(ICONS.lightOn));
    vi.unstubAllGlobals();
  });

  it('keeps the light button disabled until the light has switched', async () => {
    const puts = lightServer({ putDelayMs: 500 });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render();
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    q('light-toggle')!.click();
    flushSync();
    expect((q('light-toggle') as HTMLButtonElement).disabled).toBe(true);
    q('light-toggle')!.click(); // the double click
    await vi.waitFor(() => expect(q('light-toggle')!.getAttribute('aria-pressed')).toBe('true'));
    expect((q('light-toggle') as HTMLButtonElement).disabled).toBe(false);
    expect(puts).toEqual(['{"on":true}']);
    vi.unstubAllGlobals();
  });

  it('enables the light button again after 2 s when the camera is slower', async () => {
    const puts = lightServer({ putDelayMs: 5000 });
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render();
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    vi.useFakeTimers();
    try {
      q('light-toggle')!.click();
      flushSync();
      await vi.advanceTimersByTimeAsync(1900);
      flushSync();
      expect((q('light-toggle') as HTMLButtonElement).disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      flushSync();
      expect((q('light-toggle') as HTMLButtonElement).disabled).toBe(false);
      expect(q('light-toggle')!.getAttribute('aria-pressed')).toBe('false'); // not switched yet
      expect(puts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
