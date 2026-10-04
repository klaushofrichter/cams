import { snapshotName, triggerDownload } from './download';
import { writable } from 'svelte/store';
import { get } from 'svelte/store';
import { apiFetch, getJson } from './api';
import { QUALITY_KEY, snapshotUrl, supportsHevc, type Quality } from './live';
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
  offlineSince?: number; // when it was first found offline
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

// What the camera is and what it streams (Settings; the Live panel said it
// before the Video page, review of #173).
export function cameraKind(s: CameraStatus | null): string {
  if (!s) return '';
  return s.simulator ? `Simulated camera (${s.simulator})` : 'Camera';
}
export function streamsText(s: CameraStatus | null): string {
  const one = (label: string, x: StreamInfo | null | undefined) =>
    x ? `${label} ${x.codec === 'h265' ? 'H.265' : 'H.264'} ${x.width}×${x.height} @${x.fps}` : null;
  return [one('Main', s?.streams?.main), one('Sub', s?.streams?.sub)].filter(Boolean).join(' · ');
}

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

// The Live panel's own actions: they need the camera, not the stream, so
// they work while the stream is closed (playback on Live, after the
// keep-alive; final review 2026-09-28).

// A request-sequence guard: a late /status answer for a camera switched
// away from must not overwrite the newer camera's status.
let statusRequest = 0;
export async function checkLiveStatus(id: string): Promise<void> {
  const seq = ++statusRequest;
  // Another camera: its status is unknown until the answer comes.
  liveUi.update((u) => ({ ...u, checking: true, ...(u.status?.id === id ? {} : { status: null, snapshotError: '' }) }));
  try {
    const result = await getJson<CameraStatus>(`/api/cameras/${encodeURIComponent(id)}/status`);
    if (seq === statusRequest) liveUi.update((u) => ({ ...u, status: result }));
  } catch {
    // The status request itself failed (network or cams down): that says
    // nothing about the camera, so it gets its own wording.
    if (seq === statusRequest) liveUi.update((u) => ({ ...u, status: { id, online: false, error: 'unreachable' } }));
  } finally {
    if (seq === statusRequest) liveUi.update((u) => ({ ...u, checking: false }));
  }
}

export function toggleMute(): void {
  liveUi.update((u) => ({ ...u, muted: !u.muted }));
}

export function toggleQuality(): void {
  liveUi.update((u) => {
    const quality = u.quality === 'sub' ? 'main' : 'sub';
    try {
      localStorage.setItem(QUALITY_KEY, quality);
    } catch {
      // not persisted
    }
    return { ...u, quality };
  });
}

// Fetch first, then save: a plain download link would silently save an
// error page (or nothing) when the camera can't take a snapshot.
export async function saveSnapshot(id: string): Promise<void> {
  if (get(liveUi).snapshotBusy) return;
  liveUi.update((u) => ({ ...u, snapshotBusy: true, snapshotError: '' }));
  try {
    const res = await apiFetch(snapshotUrl(id));
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error(String(res.status));
    const url = URL.createObjectURL(await res.blob());
    triggerDownload(url, snapshotName(id, 'live', Date.now()));
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    liveUi.update((u) => ({ ...u, snapshotError: "The snapshot couldn't be taken. The camera may be busy or offline." }));
  } finally {
    liveUi.update((u) => ({ ...u, snapshotBusy: false }));
  }
}

// True while the video page holds the live stream open (on screen, or kept
// alive after leaving it): App keeps the page mounted meanwhile.
export const liveStreamHeld = writable(false);

// The line under Live's connecting indicator: how long the stream stays
// connected after leaving the page (the liveKeepAlive preference).
export function keepAliveNote(seconds: number): string {
  if (seconds <= 0) return 'The stream disconnects when you leave this page.';
  const time = seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  return `The stream stays connected for ${time} after you leave this page.`;
}
