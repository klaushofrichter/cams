// web/src/components/StripPlayer.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StripPlayer from './StripPlayer.svelte';
import { clipRuns, type Coverage } from '../lib/strip';
import type { EventClip } from '../lib/recordings';
import { currentPlayer } from '../lib/videoMode';
import { liveUi } from '../lib/liveUi';
import { localClock } from '../lib/clock';
import { get } from 'svelte/store';
import { exitPlayerFullscreen, playerFs } from '../lib/playerFullscreen';

const T = Date.parse('2026-09-27T12:00:00-05:00');
const clip: EventClip = { id: '20260927-120010-120020', start: new Date(T + 10_000).toISOString(), end: new Date(T + 20_000).toISOString(), durationSec: 10, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
const cov: Coverage = { clips: clipRuns([clip]), stills: [{ start: T, end: T + 30_000 }], previews: [] };

// jsdom has no media: a video "plays" when the test says so.
beforeEach(() => {
  vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(function (this: HTMLMediaElement) { return Promise.resolve(); }) });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
  // Stills "load" at once.
  vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { queueMicrotask(() => this.onload?.()); } });
});
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function render(extra: Record<string, unknown> = {}) {
  const props = $state({ cam: 'den', coverage: cov, previews: [], now: T + 3_600_000, at: T, playing: false, onclipfail: vi.fn(), onstep: vi.fn(), ...extra });
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(StripPlayer, { target, props });
  flushSync();
  return props;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
};

describe('StripPlayer', () => {
  it('plays stills in real time and says so', async () => {
    const p = render();
    expect(q('source-badge')!.textContent).toBe('Stills 1 FPS');
    q('play-toggle')!.click();
    await tick(3000);
    expect(p.at).toBe(T + 3000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 3000}.jpg`);
  });

  it('switches to the clip at its start, preloaded, and back to stills after it', async () => {
    const p = render({ playing: true, at: T + 5000 });
    await tick(2500); // within 3 s of the clip: preloading
    const vids = [...target!.querySelectorAll('video')] as HTMLVideoElement[];
    expect(vids.some((v) => v.getAttribute('src') === `/api/cameras/den/clips/${clip.id}/video`)).toBe(true);
    await tick(3000);
    expect(q('source-badge')!.textContent).toBe('SD 10 FPS');
    const video = q('clip-video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 10 });
    video.dispatchEvent(new Event('ended'));
    flushSync();
    expect(p.at).toBe(T + 20_000);
    expect(q('source-badge')!.textContent).toBe('Stills 1 FPS');
  });

  it('marks a failing clip once and keeps playing', async () => {
    const onclipfail = vi.fn();
    render({ playing: true, at: T + 10_000, onclipfail });
    (q('clip-video') as HTMLVideoElement).dispatchEvent(new Event('error'));
    flushSync();
    expect(onclipfail).toHaveBeenCalledTimes(1);
    expect(onclipfail).toHaveBeenCalledWith(clip.id);
  });

  it('keeps the last good still when one fails', async () => {
    const bad = `/stills/${T + 2000}.jpg`;
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(v: string) { queueMicrotask(() => (v.endsWith(bad) ? this.onerror?.() : this.onload?.())); } });
    render({ playing: true, coverage: { clips: [], stills: [{ start: T, end: T + 30_000 }], previews: [] } });
    await tick(1000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 1000}.jpg`);
    await tick(1000); // T+2000 fails to load
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 1000}.jpg`);
    await tick(1000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 3000}.jpg`);
  });

  it('shows the panel where nothing was recorded and plays through in real time', async () => {
    const p = render({ coverage: { clips: [], stills: [], previews: [] }, playing: true });
    expect(q('strip-empty')).not.toBeNull();
    expect(q('source-badge')!.textContent).toBe('No recording');
    await tick(5000);
    expect(p.at).toBe(T + 5000);
  });

  it('stops at now and never runs past it', async () => {
    const p = render({ coverage: { clips: [], stills: [], previews: [] }, playing: true, now: T + 2000 });
    await tick(10_000);
    expect(p.at).toBe(T + 2000);
    expect(p.playing).toBe(false);
    expect(q('source-badge')!.textContent).toBe('Later than now');
  });

  it('does not count time while paused, and a blocked play() leaves it paused', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.reject(new DOMException('blocked', 'NotAllowedError'))) });
    const p = render({ at: T + 10_000 });
    (q('clip-video') as HTMLVideoElement).dispatchEvent(new Event('loadedmetadata')); // as the browser does
    await tick(5000);
    expect(p.at).toBe(T + 10_000);
    q('play-toggle')!.click();
    await tick(0);
    expect(p.playing).toBe(false);
  });

  it('plays with Space and steps 10 s with the arrow keys', async () => {
    const p = render();
    const box = q('strip-player')!;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(p.at).toBe(T + 10_000);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    flushSync();
    expect(p.playing).toBe(true);
  });

  it('steps 10 s into a clip even when the clip is after now (camera clock ahead)', async () => {
    const p = render({ now: T + 5000 });
    q('fwd-10')!.click();
    expect(p.at).toBe(T + 10_000);
  });

  it('keeps playing when play() fails only because the clip was still loading, and starts it once it can', async () => {
    let calls = 0;
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => (++calls === 1 ? Promise.reject(new DOMException('no source', 'NotSupportedError')) : Promise.resolve())) });
    const p = render({ at: T + 10_000, playing: true });
    (q('clip-video') as HTMLVideoElement).dispatchEvent(new Event('loadedmetadata')); // play() #1 fails: not loaded
    await tick(0);
    expect(p.playing).toBe(true);
    (q('clip-video') as HTMLVideoElement).dispatchEvent(new Event('canplay'));
    await tick(0);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('fails a clip whose preload failed, instead of stalling on it (review #1)', async () => {
    const onclipfail = vi.fn();
    render({ playing: true, at: T + 5000, onclipfail });
    await tick(2500); // within 3 s: the idle slot preloads the clip
    const idle = q('clip-video-idle') as HTMLVideoElement;
    expect(idle.getAttribute('src')).toBe(`/api/cameras/den/clips/${clip.id}/video`);
    idle.dispatchEvent(new Event('error'));
    flushSync();
    expect(onclipfail).toHaveBeenCalledWith(clip.id);
  });

  it('a jump into the middle of another clip does not snap to its start (review #2)', async () => {
    const b: EventClip = { ...clip, id: '20260927-120040-120100', start: new Date(T + 40_000).toISOString(), end: new Date(T + 60_000).toISOString(), durationSec: 20 };
    const p = render({ at: T + 12_000, coverage: { clips: clipRuns([clip, b]), stills: [], previews: [] } });
    await tick(0);
    p.at = T + 50_000; // mid b
    flushSync();
    const v = q('clip-video') as HTMLVideoElement;
    Object.defineProperty(v, 'currentTime', { configurable: true, writable: true, value: 0 });
    v.dispatchEvent(new Event('timeupdate')); // the new src resets the position to 0
    flushSync();
    expect(p.at).toBe(T + 50_000);
    v.dispatchEvent(new Event('loadedmetadata'));
    flushSync();
    expect(v.currentTime).toBe(10);
  });

  it('plays clips muted, as before (review #3)', () => {
    render({ at: T + 12_000 });
    for (const v of target!.querySelectorAll('video')) expect((v as HTMLVideoElement).muted).toBe(true);
  });

  it('asks for each still once, and not again soon after it failed (review #4)', async () => {
    let made = 0;
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { made++; queueMicrotask(() => this.onerror?.()); } });
    render({ playing: true, coverage: { clips: [], stills: [{ start: T, end: T + 30_000 }], previews: [] } });
    await tick(3000);
    expect(made).toBeLessThanOrEqual(8); // 4 at the start, then about one new second each second
  });

  it('steps 10 s and to the previous or next event', async () => {
    const onstep = vi.fn();
    const p = render({ onstep });
    q('fwd-10')!.click();
    expect(p.at).toBe(T + 10_000);
    q('back-10')!.click();
    expect(p.at).toBe(T);
    q('next-clip')!.click();
    expect(onstep).toHaveBeenCalledWith(1);
  });

  // One-second steps beside the 10 s ones (Klaus, 2026-10-03).
  it('lays out ⏮ << < ▶ > >> ⏭ with explicit names and titles', () => {
    render();
    const ids = [...target!.querySelectorAll('.controls > button')].map((b) => b.getAttribute('data-testid'));
    expect(ids.slice(0, 7)).toEqual(['prev-clip', 'back-10', 'back-1', 'play-toggle', 'fwd-1', 'fwd-10', 'next-clip']);
    const names: Record<string, string> = { 'back-10': 'Back 10 seconds', 'back-1': 'Back 1 second', 'fwd-1': 'Forward 1 second', 'fwd-10': 'Forward 10 seconds' };
    for (const [id, name] of Object.entries(names)) {
      const b = q(id)!;
      expect(b.getAttribute('aria-label')).toBe(name);
      expect(b.title).toBe(name);
      expect(b.textContent!.trim()).toBe(''); // icons only, no "10"
    }
  });

  it('steps 1 s with the buttons and Shift+arrow keys', () => {
    const p = render({ at: T + 5000 });
    q('fwd-1')!.click();
    expect(p.at).toBe(T + 6000);
    q('back-1')!.click();
    q('back-1')!.click();
    expect(p.at).toBe(T + 4000);
    const box = q('strip-player')!;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(p.at).toBe(T + 5000);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    expect(p.at).toBe(T + 4000);
  });

  it('leaves Alt, Ctrl and Meta with an arrow to the browser (Back / Forward)', () => {
    const p = render({ at: T + 5000 });
    const box = q('strip-player')!;
    for (const mod of ['altKey', 'ctrlKey', 'metaKey']) {
      for (const key of ['ArrowLeft', 'ArrowRight']) {
        const e = new KeyboardEvent('keydown', { key, [mod]: true, bubbles: true, cancelable: true });
        box.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(false);
      }
    }
    expect(p.at).toBe(T + 5000);
  });

  it('a 1 s step on a paused clip seeks the video, so the new frame shows', async () => {
    const p = render({ at: T + 12_000 });
    const v = q('clip-video') as HTMLVideoElement;
    Object.defineProperty(v, 'currentTime', { configurable: true, writable: true, value: 0 });
    v.dispatchEvent(new Event('loadedmetadata'));
    flushSync();
    expect(v.currentTime).toBe(2);
    q('fwd-1')!.click();
    flushSync();
    expect(p.at).toBe(T + 13_000);
    expect(v.currentTime).toBe(3);
    q('back-1')!.click();
    flushSync();
    expect(v.currentTime).toBe(2);
    expect(p.playing).toBe(false);
  });

  it('a 1 s step while a clip plays is not undone by the video\'s own time', async () => {
    const p = render({ at: T + 12_000, playing: true });
    const v = q('clip-video') as HTMLVideoElement;
    Object.defineProperty(v, 'currentTime', { configurable: true, writable: true, value: 0 });
    v.dispatchEvent(new Event('loadedmetadata'));
    flushSync();
    q('fwd-1')!.click();
    flushSync();
    expect(v.currentTime).toBe(3);
    v.dispatchEvent(new Event('timeupdate'));
    flushSync();
    expect(p.at).toBe(T + 13_000);
  });

  it('disables forward 10 s and next event in live view, and the arrow keys do nothing (#121)', () => {
    const onstep = vi.fn();
    const p = render({ glued: true, at: T + 1000, onstep });
    for (const id of ['fwd-10', 'fwd-1', 'next-clip']) {
      const b = q(id) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe('Not available in live view');
      b.click();
    }
    expect(onstep).not.toHaveBeenCalled();
    q('strip-player')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(p.at).toBe(T + 1000);
    // backwards is how live goes to History
    expect((q('back-10') as HTMLButtonElement).disabled).toBe(false);
    expect((q('back-1') as HTMLButtonElement).disabled).toBe(false);
    expect((q('prev-clip') as HTMLButtonElement).disabled).toBe(false);
  });

  it('enables them again once the viewer is in history (#121)', () => {
    const p = render({ glued: true }) as unknown as { glued: boolean; at: number };
    expect((q('fwd-10') as HTMLButtonElement).disabled).toBe(true);
    p.glued = false;
    flushSync();
    for (const id of ['fwd-10', 'fwd-1', 'next-clip']) {
      const b = q(id) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      expect(b.title).not.toBe('Not available in live view');
    }
    q('strip-player')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(p.at).toBe(T + 10_000);
  });

  it('names time, source and the clip’s triggers in one line under the video (Klaus, 2026-09-28)', () => {
    const personClip: EventClip = { ...clip, triggers: ['person', 'motion'] };
    render({ at: T + 12_000, coverage: { clips: clipRuns([personClip]), stills: [], previews: [] } });
    const line = q('strip-info')!.textContent!.replace(/\s+/g, ' ').trim();
    // the date too (it can be another day), and roughly how long ago
    expect(line).toMatch(/^Sun Sep 27, \d{2}:\d{2}:\d{2}( [AP]M)? · 59 minutes ago · SD 10 FPS · Motion, Person$/);
    expect(target!.querySelector('.box [data-testid="source-badge"]')).toBeNull(); // no overlay on the video
  });

  // Klaus, 2026-09-29: no silent downloads. The player's download button
  // opens the same save dialog as the History cards.
  it('opens the save dialog from its download button instead of downloading', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"available":true}', { status: 200 })));
    render({ at: T + 12_000 });
    const b = q('clip-download')!;
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('href')).toBeNull();
    b.click();
    flushSync();
    expect(document.querySelector('[data-testid="compose-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="compose-thumb"]')!.getAttribute('src')).toContain(clip.id);
  });

  // iPhone, 2026-10-04: the button came and went with the clip under the
  // playhead, and the strip below it jumped. Without a clip it keeps its room.
  it('keeps the download button, hidden and off, where there is no clip', () => {
    render({ at: T + 25_000 }); // a still, no clip
    const b = q('clip-download')!;
    expect(b).not.toBeNull();
    expect(b.classList.contains('off')).toBe(true);
    expect((b as HTMLButtonElement).disabled).toBe(true);
    b.click();
    flushSync();
    expect(document.querySelector('[data-testid="compose-dialog"]')).toBeNull();
  });

  // 2026-09-29: dragging across four hours asked for 2,542 stills in a minute,
  // which spent cams' media budget and emptied the Timeline. While the
  // position moves by hand, no still per second: only where it settles.
  it('asks for stills only where a drag settles, not for every second it passes', async () => {
    const urls: string[] = [];
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(v: string) { urls.push(v); queueMicrotask(() => this.onload?.()); } });
    const H4 = 4 * 3_600_000;
    const p = render({ now: T + H4 + 60_000, coverage: { clips: [], stills: [{ start: T, end: T + H4 }], previews: [] } });
    const before = urls.length;
    for (let i = 1; i <= 500; i++) {
      p.at = T + Math.round((i * (H4 - 1000)) / 500); // the last second inside the stills
      flushSync();
      await tick(2); // a quick drag: 500 positions in about a second
    }
    expect(urls.length - before).toBeLessThanOrEqual(8);
    await tick(300); // settled
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + H4 - 1000}.jpg`);
  });

  // The Video page (spec 2026-10-04): a badge on the player says the mode.
  it('badges live as ● LIVE, and a recording as REC with its time', () => {
    liveUi.update((u) => ({ ...u, playerState: 'playing', stillsShowing: false, status: { id: 'den', online: true } }));
    const p = render({ glued: true, now: T + 2000, at: T }) as unknown as { glued: boolean };
    expect(q('mode-badge')!.textContent!.trim()).toBe('● LIVE');
    expect(q('mode-badge')!.dataset.mode).toBe('live');
    p.glued = false;
    flushSync();
    expect(q('mode-badge')!.textContent!.trim()).toBe(`REC ${localClock(T)} · Still`);
    expect(q('mode-badge')!.dataset.mode).toBe('rec');
  });

  // Review of #173: no LIVE before the live video plays.
  it('does not say LIVE while connecting or offline', () => {
    liveUi.update((u) => ({ ...u, playerState: 'connecting', stillsShowing: false, status: { id: 'den', online: true } }));
    render({ glued: true, now: T + 2000, at: T });
    expect(q('mode-badge')!.textContent!.trim()).toBe('Connecting…');
    liveUi.update((u) => ({ ...u, status: { id: 'den', online: false } }));
    flushSync();
    expect(q('mode-badge')!.textContent!.trim()).toBe('Offline');
    liveUi.update((u) => ({ ...u, playerState: 'playing', status: { id: 'den', online: true } }));
    flushSync();
    expect(q('mode-badge')!.textContent!.trim()).toBe('● LIVE');
  });

  // Klaus, 2026-10-04: REC says what it shows (the clip's stream: sub SD, main 4K; the stills: Still).
  it('adds SD, 4K or Still to the REC badge, and its aria-label', async () => {
    const p = render({ at: T + 12_000 }) as unknown as { at: number; clipStream: 'sub' | 'main' };
    await tick(0);
    expect(q('mode-badge')!.textContent!.trim()).toBe(`REC ${localClock(T + 12_000)} · SD`);
    expect(q('mode-badge')!.getAttribute('aria-label')).toBe(`REC ${localClock(T + 12_000)} · SD, back to live`);
    p.clipStream = 'main';
    flushSync();
    expect(q('mode-badge')!.textContent!.trim()).toBe(`REC ${localClock(T + 12_000)} · 4K`);
    expect(q('mode-badge')!.getAttribute('aria-label')).toBe(`REC ${localClock(T + 12_000)} · 4K, back to live`);
    p.clipStream = 'sub';
    flushSync();
    expect(q('mode-badge')!.textContent!.trim()).toBe(`REC ${localClock(T + 12_000)} · SD`);
    p.at = T + 3000; // the stills
    flushSync();
    expect(q('mode-badge')!.textContent!.trim()).toBe(`REC ${localClock(T + 3000)} · Still`);
    expect(q('mode-badge')!.getAttribute('aria-label')).toBe(`REC ${localClock(T + 3000)} · Still, back to live`);
    p.at = T + 40_000; // nothing recorded
    flushSync();
    expect(q('mode-badge')!.textContent!.trim()).toBe(`REC ${localClock(T + 40_000)}`);
  });

  it('keeps the live badges as they were (no SD, 4K or Still)', () => {
    liveUi.update((u) => ({ ...u, playerState: 'playing', stillsShowing: false, status: { id: 'den', online: true } }));
    render({ glued: true, now: T + 2000, at: T + 12_000 });
    expect(q('mode-badge')!.textContent!.trim()).toBe('● LIVE');
    liveUi.update((u) => ({ ...u, playerState: 'connecting', stillsShowing: true }));
    flushSync();
    expect(q('mode-badge')!.textContent!.trim()).toBe('● STILLS');
  });

  // Klaus 2026-10-06 (screenshot): the line under the player read "● STILLS · STILLS";
  // its source part says what the stills are, as for recorded stills.
  it('the info line under live stills names the stills once', () => {
    liveUi.update((u) => ({ ...u, playerState: 'connecting', stillsShowing: true, badge: '● STILLS', status: { id: 'den', online: true } }));
    render({ glued: true, now: T + 2000, at: T + 12_000 });
    expect(q('live-badge')!.textContent!.trim()).toBe('● STILLS');
    expect(q('source-badge')!.textContent!.trim()).toBe('Stills 1 FPS');
    expect(q('strip-info')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('● STILLS · Stills 1 FPS');
  });

  it('a click on the REC badge goes back to live; the LIVE badge is no button', () => {
    const onglue = vi.fn();
    const p = render({ onglue }) as unknown as { glued: boolean };
    expect(q('mode-badge')!.tagName).toBe('BUTTON');
    expect(q('mode-badge')!.getAttribute('aria-label')).toBe(`REC ${localClock(T)} · Still, back to live`);
    q('mode-badge')!.click();
    expect(onglue).toHaveBeenCalledTimes(1);
    p.glued = true;
    flushSync();
    expect(q('mode-badge')!.tagName).toBe('SPAN');
  });

  it('tells the page what it shows: the clip’s video, a still, or nothing', async () => {
    render({ at: T + 12_000 });
    await tick(0);
    const f = currentPlayer()!.frame();
    expect(f?.kind).toBe('clip');
    expect(f && f.kind === 'clip' && f.video).toBe(q('clip-video'));
    unmount(component!);
    target!.remove();
    expect(currentPlayer()).toBeNull();
    render({ at: T + 3000 });
    expect(currentPlayer()!.frame()).toEqual({ kind: 'still', url: `/api/cameras/den/stills/${T + 3000}.jpg`, at: T + 3000 });
    unmount(component!);
    target!.remove();
    render({ at: T + 40_000 }); // no recording there
    expect(currentPlayer()!.frame()).toBeNull();
    unmount(component!);
    target!.remove();
    render({ glued: true, now: T + 2000 }); // live: the page saves the camera's own snapshot
    expect(currentPlayer()!.frame()).toBeNull();
  });
});

// Fullscreen (#182, spec 2026-10-04-fullscreen-recorded): the player box in
// every mode, so the mode badge is inside what goes fullscreen.
describe('StripPlayer fullscreen', () => {
  const fsEnabled = (on: boolean) => Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: on });
  afterEach(() => {
    exitPlayerFullscreen();
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  });

  it('puts the box with the mode badge into fullscreen, live and in a recording', async () => {
    fsEnabled(true);
    const calls: Element[] = [];
    HTMLElement.prototype.requestFullscreen = vi.fn(async function (this: HTMLElement) { calls.push(this); });
    const p = render({ glued: true, now: T + 2000, at: T }) as unknown as { glued: boolean };
    currentPlayer()!.fullscreen();
    await tick(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].contains(q('mode-badge'))).toBe(true); // the bug: LiveBox fullscreened only the live layer
    expect(get(playerFs)).toBe('element');
    expect(q('fs-overlay')!.dataset.kind).toBe('element');
    p.glued = false; // a recording: the same fullscreen, the same box
    flushSync();
    expect(calls[0].contains(q('mode-badge'))).toBe(true);
    expect(q('mode-badge')!.dataset.mode).toBe('rec');
    expect(q('fs-overlay')).not.toBeNull();
  });

  it('fills the screen without element fullscreen (iPhone), and leaves it', async () => {
    fsEnabled(false);
    render();
    expect(q('fs-overlay')).toBeNull();
    currentPlayer()!.fullscreen();
    await tick(0);
    const box = q('mode-badge')!.parentElement!;
    expect(box.classList.contains('fill')).toBe(true);
    expect(q('fs-overlay')!.dataset.kind).toBe('fill');
    q('fs-exit')!.click();
    flushSync();
    expect(box.classList.contains('fill')).toBe(false);
    expect(q('fs-overlay')).toBeNull();
  });

  it('steps with the keys once each, and jumps events, while fullscreen', async () => {
    fsEnabled(false);
    const onstep = vi.fn();
    const p = render({ at: T, onstep });
    currentPlayer()!.fullscreen();
    await tick(0);
    // On the player (its own key handler steps aside) and on the window.
    q('strip-player')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    flushSync();
    expect(p.at).toBe(T + 10_000);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }));
    flushSync();
    expect(p.at).toBe(T + 9000);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
    expect(onstep.mock.calls).toEqual([[1], [-1]]);
    q('fs-fwd-1')!.click();
    flushSync();
    expect(p.at).toBe(T + 10_000);
  });

  it('live: forward and the next event do nothing, back leaves live', async () => {
    fsEnabled(false);
    const onstep = vi.fn();
    const p = render({ glued: true, now: T + 2000, at: T, onstep });
    currentPlayer()!.fullscreen();
    await tick(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));
    flushSync();
    expect(p.at).toBe(T);
    expect(onstep).not.toHaveBeenCalled();
    expect(q('fs-hint')!.textContent).toBe('');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    flushSync();
    expect(p.at).toBe(T - 10_000);
  });

  // Review of #185: ⏭ Event only when it jumped; ⏮/⏭ off at the ends.
  it('hints an event jump only when there was one, and passes the ends on', async () => {
    fsEnabled(false);
    let jumped = false;
    const onstep = vi.fn(() => jumped);
    const p = render({ at: T, onstep, stepAvail: { prev: false, next: true } }) as unknown as { stepAvail: { prev: boolean; next: boolean } };
    currentPlayer()!.fullscreen();
    await tick(0);
    expect((q('fs-prev-event') as HTMLButtonElement).disabled).toBe(true);
    expect((q('fs-next-event') as HTMLButtonElement).disabled).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));
    flushSync();
    expect(onstep).toHaveBeenCalledWith(1);
    expect(q('fs-hint')!.textContent).toBe('');
    jumped = true;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));
    flushSync();
    expect(q('fs-hint')!.textContent).toBe('⏭ Event');
    p.stepAvail = { prev: true, next: false };
    flushSync();
    expect((q('fs-prev-event') as HTMLButtonElement).disabled).toBe(false);
    expect((q('fs-next-event') as HTMLButtonElement).disabled).toBe(true);
  });
});
