import { get, writable, type Readable } from 'svelte/store';
import { guardBack } from './router';

// Fullscreen for the player box in every mode (#182, spec
// 2026-10-04-fullscreen-recorded): element fullscreen where the browser has
// it, else "fill the screen" (a fixed full-viewport layer; the iPhone, where
// no browser has element fullscreen). Feature detection only.
export type FsKind = 'off' | 'element' | 'fill';
const state = writable<FsKind>('off');
export const playerFs: Readable<FsKind> = { subscribe: state.subscribe };

export type FsAction = { kind: 'skip'; ms: number } | { kind: 'event'; dir: -1 | 1 } | { kind: 'toggle' } | { kind: 'exit' };

type Keyish = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

// ←/→ 10 s, Shift+←/→ 1 s, [ ] or PgUp/PgDn an event, Space play/pause, Esc
// leave. Alt / Ctrl / Meta with a key stay the browser's.
export function fsKey(e: Keyish): FsAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const ms = e.shiftKey ? 1000 : 10_000;
      return { kind: 'skip', ms: e.key === 'ArrowLeft' ? -ms : ms };
    }
    case '[':
    case 'PageUp':
      return { kind: 'event', dir: -1 };
    case ']':
    case 'PageDown':
      return { kind: 'event', dir: 1 };
    case ' ':
      return { kind: 'toggle' };
    case 'Escape':
      return { kind: 'exit' };
    default:
      return null;
  }
}

// The short hint in the middle of the picture; `playing` is the state after
// the action.
export function hintFor(a: FsAction, playing: boolean): string {
  switch (a.kind) {
    case 'skip':
      return `${a.ms < 0 ? '−' : '+'}${Math.abs(a.ms) / 1000} s`;
    case 'event':
      return a.dir < 0 ? '⏮ Event' : '⏭ Event';
    case 'toggle':
      return playing ? '▶' : '⏸';
    default:
      return '';
  }
}

type FsDoc = { fullscreenEnabled?: boolean; webkitFullscreenEnabled?: boolean };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };

export function canElementFullscreen(el: HTMLElement, doc: FsDoc = document as FsDoc): boolean {
  const e = el as FsElement;
  return !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled) && (typeof e.requestFullscreen === 'function' || typeof e.webkitRequestFullscreen === 'function');
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  // The browser's own exit (Esc, Android's Back) ends element fullscreen.
  const onChange = () => {
    const d = document as Document & { webkitFullscreenElement?: Element | null };
    if (!(document.fullscreenElement ?? d.webkitFullscreenElement) && get(state) === 'element') {
      state.set('off');
      restoreFocus();
    }
  };
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
}

const FILL_CLASS = 'player-fill';
let stopGuard: (() => void) | null = null;

function enterFill() {
  document.documentElement.classList.add(FILL_CLASS);
  state.set('fill');
  // Back leaves fill mode (it isn't the browser's fullscreen, so the browser
  // wouldn't): an entry with the same URL for Back to take, and the router's
  // guard keeps the position on screen (the entry below has an older one).
  history.pushState({ ...(history.state ?? {}), cvFill: true }, '', location.href);
  stopGuard = guardBack(() => {
    leaveFill();
    return true;
  });
}

function leaveFill() {
  document.documentElement.classList.remove(FILL_CLASS);
  state.set('off');
  restoreFocus();
  stopGuard?.();
  stopGuard = null;
}

// Where the focus was when fullscreen was asked for (the Fullscreen
// button): given back once fullscreen has ended (review of #185). Not
// before: while an element is fullscreen the browser won't focus anything
// outside it.
let focusBefore: Element | null = null;
export function focusBeforeFullscreen(): Element | null {
  return focusBefore;
}
function restoreFocus() {
  const el = focusBefore;
  focusBefore = null;
  // After the overlay is gone (it un-inerts the page) and the browser has left fullscreen.
  setTimeout(() => {
    if (el instanceof HTMLElement && el.isConnected && document.activeElement !== el) el.focus({ preventScroll: true });
  }, 0);
}

export async function enterPlayerFullscreen(el: HTMLElement): Promise<'element' | 'fill'> {
  if (get(state) !== 'off') return get(state) as 'element' | 'fill';
  focusBefore = document.activeElement;
  listen();
  if (canElementFullscreen(el)) {
    const e = el as FsElement;
    try {
      if (typeof e.requestFullscreen === 'function') await e.requestFullscreen();
      else e.webkitRequestFullscreen!();
      state.set('element');
      return 'element';
    } catch {
      // refused: fill the screen instead
    }
  }
  enterFill();
  return 'fill';
}

export function exitPlayerFullscreen(): void {
  const s = get(state);
  if (s === 'element') {
    state.set('off');
    if (document.fullscreenElement) void document.exitFullscreen().then(restoreFocus, restoreFocus);
    else restoreFocus();
  } else if (s === 'fill') {
    const ours = !!(history.state as { cvFill?: boolean } | null)?.cvFill;
    if (ours) {
      // Take our entry off again; its popstate (one, always: the entry is
      // on top) changes nothing.
      leaveFill();
      const stop = guardBack(() => {
        stop();
        return true;
      });
      history.back();
    } else leaveFill();
  }
}
