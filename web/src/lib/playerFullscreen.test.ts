// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  canElementFullscreen, enterPlayerFullscreen, exitPlayerFullscreen, fsKey, hintFor, playerFs,
} from './playerFullscreen';
import { initRouter, replaceRoute } from './router';

// Fullscreen for the player box (#182, spec 2026-10-04-fullscreen-recorded).
const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });

describe('fsKey', () => {
  it('maps the arrows to 10 s and Shift+arrows to 1 s', () => {
    expect(fsKey(key('ArrowLeft'))).toEqual({ kind: 'skip', ms: -10_000 });
    expect(fsKey(key('ArrowRight'))).toEqual({ kind: 'skip', ms: 10_000 });
    expect(fsKey(key('ArrowLeft', { shiftKey: true }))).toEqual({ kind: 'skip', ms: -1000 });
    expect(fsKey(key('ArrowRight', { shiftKey: true }))).toEqual({ kind: 'skip', ms: 1000 });
  });
  it('maps [ ] and PgUp/PgDn to the previous/next event', () => {
    expect(fsKey(key('['))).toEqual({ kind: 'event', dir: -1 });
    expect(fsKey(key(']'))).toEqual({ kind: 'event', dir: 1 });
    expect(fsKey(key('PageUp'))).toEqual({ kind: 'event', dir: -1 });
    expect(fsKey(key('PageDown'))).toEqual({ kind: 'event', dir: 1 });
  });
  it('maps Space to play/pause and Esc to leave', () => {
    expect(fsKey(key(' '))).toEqual({ kind: 'toggle' });
    expect(fsKey(key('Escape'))).toEqual({ kind: 'exit' });
  });
  it('leaves the browser its own keys', () => {
    expect(fsKey(key('ArrowLeft', { altKey: true }))).toBeNull();
    expect(fsKey(key('ArrowRight', { metaKey: true }))).toBeNull();
    expect(fsKey(key('ArrowLeft', { ctrlKey: true }))).toBeNull();
    expect(fsKey(key('a'))).toBeNull();
    expect(fsKey(key('Tab'))).toBeNull();
  });
});

describe('hintFor', () => {
  it('says what a step, an event jump or play/pause did', () => {
    expect(hintFor({ kind: 'skip', ms: -10_000 }, false)).toBe('−10 s');
    expect(hintFor({ kind: 'skip', ms: 1000 }, false)).toBe('+1 s');
    expect(hintFor({ kind: 'event', dir: -1 }, false)).toBe('⏮ Event');
    expect(hintFor({ kind: 'event', dir: 1 }, false)).toBe('⏭ Event');
    expect(hintFor({ kind: 'toggle' }, true)).toBe('▶');
    expect(hintFor({ kind: 'toggle' }, false)).toBe('⏸');
    expect(hintFor({ kind: 'exit' }, false)).toBe('');
  });
});

describe('canElementFullscreen', () => {
  it('needs the document to allow it and the element to have the call', () => {
    const el = document.createElement('div');
    el.requestFullscreen = vi.fn(async () => {});
    expect(canElementFullscreen(el, { fullscreenEnabled: true })).toBe(true);
    expect(canElementFullscreen(el, { fullscreenEnabled: false })).toBe(false); // iPhone: no element fullscreen
    const prefixed = document.createElement('div') as HTMLDivElement & { webkitRequestFullscreen?: () => void };
    (prefixed as unknown as { requestFullscreen?: unknown }).requestFullscreen = undefined;
    prefixed.webkitRequestFullscreen = vi.fn();
    expect(canElementFullscreen(prefixed, { webkitFullscreenEnabled: true })).toBe(true);
    const none = document.createElement('div');
    (none as unknown as { requestFullscreen?: unknown }).requestFullscreen = undefined;
    expect(canElementFullscreen(none, { fullscreenEnabled: true })).toBe(false);
  });
});

describe('enterPlayerFullscreen', () => {
  let stopRouter: () => void;
  beforeEach(() => {
    history.replaceState({}, '', '/app/video?cam=cam1&at=1000');
    stopRouter = initRouter();
  });
  afterEach(() => {
    exitPlayerFullscreen();
    stopRouter();
    document.documentElement.classList.remove('player-fill');
    vi.unstubAllGlobals();
  });

  it('uses element fullscreen where the browser has it', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    const el = document.createElement('div');
    el.requestFullscreen = vi.fn(async () => {});
    expect(await enterPlayerFullscreen(el)).toBe('element');
    expect(el.requestFullscreen).toHaveBeenCalled();
    expect(get(playerFs)).toBe('element');
  });

  it('fills the screen without element fullscreen, and with a refused request', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    const el = document.createElement('div');
    expect(await enterPlayerFullscreen(el)).toBe('fill');
    expect(get(playerFs)).toBe('fill');
    expect(document.documentElement.classList.contains('player-fill')).toBe(true);
    exitPlayerFullscreen();
    expect(get(playerFs)).toBe('off');
    expect(document.documentElement.classList.contains('player-fill')).toBe(false);

    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    el.requestFullscreen = vi.fn(async () => { throw new Error('not allowed'); });
    expect(await enterPlayerFullscreen(el)).toBe('fill');
  });

  it('fill mode: Back leaves it and keeps the position on screen', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    const before = history.length;
    await enterPlayerFullscreen(document.createElement('div'));
    expect(history.length).toBe(before + 1); // an entry for Back to take
    replaceRoute('/app/video?cam=cam1&at=5000'); // playing moved on
    expect(history.state?.cvFill).toBe(true); // a replace keeps the entry's mark
    // Back: the browser shows the entry below (the older position), then popstate.
    history.replaceState({}, '', '/app/video?cam=cam1&at=1000');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(get(playerFs)).toBe('off');
    expect(location.search).toBe('?cam=cam1&at=5000'); // not jumped back
  });

  it('gives the focus back to where it was once fullscreen ends (review of #185)', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await enterPlayerFullscreen(document.createElement('div'));
    document.body.focus();
    (document.activeElement as HTMLElement | null)?.blur();
    exitPlayerFullscreen();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});
