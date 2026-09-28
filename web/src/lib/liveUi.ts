import { writable } from 'svelte/store';
import { QUALITY_KEY, supportsHevc, type Quality } from './live';
import type { PlayerState } from './liveSession';
import { pref } from './preferences';

// The live stream's shared state (spec 2026-09-28): LiveBox (inside the
// player column) owns the stream and writes this; the Live panel reads it
// and calls liveActions for its buttons.

export interface StreamInfo {
  codec: 'h264' | 'h265';
  width: number;
  height: number;
  fps: number;
}
export interface CameraStatus {
  id: string;
  online: boolean;
  model?: string;
  firmware?: string;
  error?: string;
  simulator?: string | null;
  streams?: { main: StreamInfo | null; sub: StreamInfo | null };
}
export interface LiveUi {
  quality: Quality;
  muted: boolean;
  hevc: boolean;
  playerState: PlayerState;
  stillsShowing: boolean;
  status: CameraStatus | null;
  checking: boolean;
  badge: string; // '● LIVE' | '● STILLS' | '● …'
  snapshotBusy: boolean;
  snapshotError: string;
}

const hevc = typeof MediaSource !== 'undefined' && supportsHevc((t) => MediaSource.isTypeSupported(t));

function initialQuality(): Quality {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(QUALITY_KEY);
  } catch {
    // not available; fall back to the stored preference below
  }
  const wanted = stored ?? pref('liveQuality') ?? 'sub';
  return hevc && wanted === 'main' ? 'main' : 'sub';
}

export const liveUi = writable<LiveUi>({
  quality: initialQuality(),
  muted: true,
  hevc,
  playerState: 'connecting',
  stillsShowing: false,
  status: null,
  checking: false,
  badge: '● …',
  snapshotBusy: false,
  snapshotError: '',
});

export function badgeOf(playerState: PlayerState, stillsShowing: boolean): string {
  return playerState === 'playing' ? '● LIVE' : stillsShowing ? '● STILLS' : '● …';
}

// One explanation per error code: camera_error covers things re-trying
// won't fix (a certificate problem, an unexpected answer), so it points at
// the server logs instead of suggesting the camera is simply unreachable.
export function offlineReason(code: string | undefined): string {
  if (code === 'camera_offline') return 'The camera could not be reached.';
  if (code === 'camera_auth_failed') return 'Signing in to the camera failed.';
  if (code === 'unreachable') return "cams couldn't check the camera (network or server problem).";
  return 'The camera answered with an error (for example a certificate problem). Check the server logs.';
}

type Actions = { toggleMute(): void; toggleQuality(): void; snapshot(): void; fullscreen(): void; retry(): void };
const noop = () => {};
const none: Actions = { toggleMute: noop, toggleQuality: noop, snapshot: noop, fullscreen: noop, retry: noop };
let handlers: Actions = none;

// The Live panel's buttons; LiveBox registers what they do.
export const liveActions: Actions = {
  toggleMute: () => handlers.toggleMute(),
  toggleQuality: () => handlers.toggleQuality(),
  snapshot: () => handlers.snapshot(),
  fullscreen: () => handlers.fullscreen(),
  retry: () => handlers.retry(),
};

export function registerLiveActions(a: Partial<Actions>): () => void {
  const mine: Actions = { ...none, ...a };
  handlers = mine;
  return () => {
    if (handlers === mine) handlers = none;
  };
}

// True while the video page holds the live stream open (on screen, or kept
// alive after leaving it): App keeps the page mounted meanwhile.
export const liveStreamHeld = writable(false);
