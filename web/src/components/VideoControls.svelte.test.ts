// web/src/components/VideoControls.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import VideoControls from './VideoControls.svelte';
import { liveUi } from '../lib/liveUi';
import { cameras } from '../lib/stores';
import { registerPlayer, type PlayerFrame } from '../lib/videoMode';
import { ICONS } from '../lib/icons';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true }, muted: true, hevc: true, quality: 'sub', snapshotBusy: false, snapshotError: '' }));
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cameras.set([]);
  liveUi.update((u) => ({ ...u, extFailed: [] }));
});
function render(extra: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(VideoControls, { target, props: { cameraId: 'cam2', mode: 'live', ...extra } });
  flushSync();
  return target;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
function lightServer(opts: { putDelayMs: number } = { putDelayMs: 0 }) {
  let on = false;
  const puts: string[] = [];
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (init?.method === 'PUT') {
      puts.push(init.body as string);
      await new Promise((r) => setTimeout(r, opts.putDelayMs));
      on = JSON.parse(init.body as string).on;
    }
    return new Response(JSON.stringify({ on }), { status: 200 });
  });
  return { puts, calls };
}

describe('VideoControls', () => {
  // Klaus, 2026-09-29: icons only, with tooltips; SD/4K.
  it('shows the controls as icons with tooltips', () => {
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

  it('mute toggles, in both modes', () => {
    render({ mode: 'rec' });
    expect(q('mute-toggle')!.disabled).toBe(false);
    q('mute-toggle')!.click();
    expect(get(liveUi).muted).toBe(false);
  });

  // Spec 2026-10-04: light and quality act on the live stream only. Review
  // of #173: they stay focusable (aria-disabled), keep their names, and a
  // click says why on screen (a phone shows no tooltip).
  it('marks quality and light "only in live mode" in a recording, still focusable', async () => {
    const { calls } = lightServer();
    render({ mode: 'rec' });
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    for (const [id, name] of [['quality-toggle', 'Quality — only in live mode'], ['light-toggle', 'Light — only in live mode']]) {
      const b = q(id)!;
      expect(b.disabled, id).toBe(false);
      expect(b.getAttribute('aria-disabled'), id).toBe('true');
      expect(b.getAttribute('aria-label'), id).toBe(name);
      expect(b.title, id).toBe('Only in live mode');
      expect(b.getAttribute('aria-describedby'), id).toBe('live-only-note');
    }
    expect(q('live-only-note')!.dataset.shown).toBe('false'); // read by screen readers, not on screen yet
    expect(q('live-only-note')!.classList.contains('sr-only')).toBe(true);
    q('quality-toggle')!.click();
    q('light-toggle')!.click();
    flushSync();
    expect(get(liveUi).quality).toBe('sub'); // nothing happened
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
    const note = q('live-only-note')!;
    expect(note.id).toBe('live-only-note');
    expect(note.textContent).toBe('Quality and light work only in live mode.');
    expect(note.dataset.shown).toBe('true');
    expect(note.classList.contains('sr-only')).toBe(false);
    expect(q('snapshot')!.disabled).toBe(false);
    expect(q('snapshot')!.title).toBe('Save this frame');
  });

  it('names quality for screen readers in live mode too', () => {
    render();
    expect(q('quality-toggle')!.getAttribute('aria-label')).toBe('Quality: SD, switch to 4K');
    expect(q('quality-toggle')!.hasAttribute('aria-disabled')).toBe(false);
  });

  it('enables them again back in live mode', async () => {
    lightServer();
    render({ mode: 'rec' });
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    unmount(component!);
    target!.remove();
    render({ mode: 'live' });
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    expect(q('quality-toggle')!.getAttribute('aria-disabled')).toBeNull();
    expect(q('light-toggle')!.getAttribute('aria-disabled')).toBeNull();
    expect(q('light-toggle')!.title).toBe('Light is off, click to turn on');
  });

  it('live: the snapshot is the camera’s, named …-live-…', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return url.endsWith('/light') ? new Response('{"on":false}') : new Response(new Blob(['jpg']), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    render();
    q('snapshot')!.click();
    await vi.waitFor(() => expect(names).toHaveLength(1));
    expect(urls).toContain('/api/cameras/cam2/snapshot.jpg');
    expect(names[0]).toMatch(/^cam2-live-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.jpg$/);
  });

  it('recording: the snapshot is the shown frame, named …-rec-… or …-still-…', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/light') ? new Response('{"on":false}') : new Response(new Blob(['jpg']), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }), toBlob: (cb: (b: Blob) => void) => cb(new Blob(['j'], { type: 'image/jpeg' })) };
    const make = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((t: string) => (t === 'canvas' ? canvas : make(t))) as typeof document.createElement);
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const at = Date.UTC(2026, 9, 3, 9, 5, 7);
    let frame: PlayerFrame = { kind: 'clip', video: { videoWidth: 896, videoHeight: 512, readyState: 4 } as unknown as HTMLVideoElement, at };
    const stop = registerPlayer({ frame: () => frame, fullscreen: () => {} });
    render({ mode: 'rec' });
    q('snapshot')!.click();
    await vi.waitFor(() => expect(names).toHaveLength(1));
    frame = { kind: 'still', url: '/api/cameras/cam2/stills/1.jpg', at };
    q('snapshot')!.click();
    await vi.waitFor(() => expect(names).toHaveLength(2));
    expect(names).toEqual(['cam2-rec-2026-10-03-09-05-07.jpg', 'cam2-still-2026-10-03-09-05-07.jpg']);
    expect(canvas.width).toBe(896);
    stop();
  });

  // #182: fullscreen works in both modes, always the player box (the live
  // box alone left the mode badge out).
  it('fullscreen is the player box, live and in a recording', () => {
    const playerFs = vi.fn();
    const stopPlayer = registerPlayer({ frame: () => null, fullscreen: playerFs });
    for (const mode of ['live', 'rec']) {
      render({ mode });
      const b = q('fullscreen')!;
      expect(b.getAttribute('aria-disabled'), mode).toBeNull();
      expect(b.getAttribute('aria-label'), mode).toBe('Fullscreen');
      expect(b.title, mode).toBe('Fullscreen');
      b.click();
      unmount(component!);
      component = undefined;
      target!.remove();
    }
    expect(playerFs).toHaveBeenCalledTimes(2);
    stopPlayer();
  });

  it('shows a failed live snapshot’s message', async () => {
    vi.stubGlobal('fetch', async () => new Response('x', { status: 500 }));
    render();
    q('snapshot')!.click();
    await vi.waitFor(() => expect(q('snapshot-error')).not.toBeNull());
  });

  // The camera's manual light (WhiteLed.state), Klaus 2026-09-29.
  it('shows the light and switches it', async () => {
    const { calls } = lightServer();
    render();
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    expect(q('light-toggle')!.getAttribute('aria-pressed')).toBe('false');
    q('light-toggle')!.click();
    await vi.waitFor(() => expect(q('light-toggle')!.getAttribute('aria-pressed')).toBe('true'));
    expect(q('light-toggle')!.title).toBe('Light is on, click to turn off');
    expect(calls[0]).toMatchObject({ url: '/api/cameras/cam2/light', method: 'GET' });
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/api/cameras/cam2/light' });
  });

  it('draws the light as a plain bulb when off and with rays when on', async () => {
    lightServer();
    render();
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    const icon = () => q('light-toggle')!.querySelector('path')!.getAttribute('d');
    expect(icon()).toBe(ICONS.light);
    q('light-toggle')!.click();
    await vi.waitFor(() => expect(icon()).toBe(ICONS.lightOn));
  });

  it('hides the light when the camera has none', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"camera_error"}', { status: 502 }));
    render();
    await new Promise((r) => setTimeout(r, 20));
    flushSync();
    expect(q('light-toggle')).toBeNull();
  });

  it('does not ask for the light while hidden', async () => {
    const { calls } = lightServer();
    render({ paused: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.url.endsWith('/light'))).toEqual([]);
  });

  it('keeps the light button disabled until the light has switched', async () => {
    const { puts } = lightServer({ putDelayMs: 500 });
    render();
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    q('light-toggle')!.click();
    flushSync();
    expect(q('light-toggle')!.disabled).toBe(true);
    q('light-toggle')!.click(); // the double click
    await vi.waitFor(() => expect(q('light-toggle')!.getAttribute('aria-pressed')).toBe('true'));
    expect(q('light-toggle')!.disabled).toBe(false);
    expect(puts).toEqual(['{"on":true}']);
  });

  it('enables the light button again after 2 s when the camera is slower', async () => {
    const { puts } = lightServer({ putDelayMs: 5000 });
    render();
    await vi.waitFor(() => expect(q('light-toggle')).not.toBeNull());
    vi.useFakeTimers();
    try {
      q('light-toggle')!.click();
      flushSync();
      await vi.advanceTimersByTimeAsync(1900);
      flushSync();
      expect(q('light-toggle')!.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      flushSync();
      expect(q('light-toggle')!.disabled).toBe(false);
      expect(q('light-toggle')!.getAttribute('aria-pressed')).toBe('false');
      expect(puts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The third stream (ext, the Reolink app's Balanced): a camera whose proxy
// lists it gets three choices, SD | Balanced | 4K; others keep the toggle.
describe('VideoControls: Balanced', () => {
  const withExt = (live: ('main' | 'ext' | 'sub')[] = ['main', 'ext', 'sub']) =>
    cameras.set([{ id: 'cam2', name: 'Garage', webUiUrl: null, capabilities: { schema: 1, ptz: null, live } }]);

  it('offers SD, Balanced and 4K for a camera with ext; the choice is kept', () => {
    withExt();
    lightServer();
    render();
    expect(q('quality-toggle')).toBeNull();
    const group = q('quality-choice')!;
    expect([...group.querySelectorAll('button')].map((b) => b.textContent!.trim())).toEqual(['SD', 'Balanced', '4K']);
    expect(q('quality-sub')!.getAttribute('aria-pressed')).toBe('true');
    q('quality-ext')!.click();
    flushSync();
    expect(get(liveUi).quality).toBe('ext');
    expect(localStorage.getItem('cams-live-quality')).toBe('ext');
    expect(q('quality-ext')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('quality-sub')!.getAttribute('aria-pressed')).toBe('false');
    q('quality-main')!.click();
    flushSync();
    expect(get(liveUi).quality).toBe('main');
  });

  it('without HEVC: SD and Balanced only (ext is H.264)', () => {
    withExt();
    lightServer();
    liveUi.update((u) => ({ ...u, hevc: false }));
    render();
    expect([...q('quality-choice')!.querySelectorAll('button')].map((b) => b.textContent!.trim())).toEqual(['SD', 'Balanced']);
  });

  it('a camera without ext (or an older proxy) keeps the SD/4K toggle; a stored Balanced shows as SD there', () => {
    withExt(['main', 'sub']);
    lightServer();
    liveUi.update((u) => ({ ...u, quality: 'ext' }));
    render();
    expect(q('quality-choice')).toBeNull();
    expect(q('quality-toggle')!.textContent!.trim()).toBe('SD');
    q('quality-toggle')!.click();
    flushSync();
    expect(get(liveUi).quality).toBe('main');
  });

  it('Balanced that did not start for this camera is disabled and says why; the camera plays SD', () => {
    withExt();
    lightServer();
    liveUi.update((u) => ({ ...u, quality: 'ext', extFailed: ['cam2'] }));
    render();
    expect(q('quality-ext')!.disabled).toBe(true);
    expect(q('quality-ext')!.title).toBe("Balanced didn't start for this camera; it plays SD");
    expect(q('quality-sub')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('in a recording the choices are only in live mode', () => {
    withExt();
    lightServer();
    render({ mode: 'recording' });
    expect(q('quality-choice')!.getAttribute('aria-label')).toBe('Quality — only in live mode');
    q('quality-ext')!.click();
    flushSync();
    expect(get(liveUi).quality).toBe('sub');
    expect(q('live-only-note')!.dataset.shown).toBe('true');
  });
});
