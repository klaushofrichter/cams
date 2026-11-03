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
  via?: 'proxy'; // reached through its cam-proxy only
  fix?: OfflineFixInfo; // a through-proxy camera that is offline: what an admin can do about it
}
// What cams can fix of a through-proxy camera that is offline (spec 2026-10-30 §6.2).
export interface OfflineFixInfo { login: 'missing' | 'refused' | null; trust: { fingerprint: string } | null; canFix: boolean }
export interface LiveUi {
  quality: Quality; // the viewer's choice (kept across cameras)
  stream?: Quality; // what the player streams now: the choice where the camera and browser allow it (LiveBox)
  videoHeight?: number; // the playing picture's height (0 or absent: not known yet); names the ext stream
  extFailed?: string[]; // cameras whose ext stream didn't start this visit: they play sub
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
  // ext stays the choice: a camera without it plays sub (effectiveQuality).
  return hevc && wanted === 'main' ? 'main' : wanted === 'ext' ? 'ext' : 'sub';
}

// Whether a camera offers the ext stream (Balanced): its cam-proxy lists it
// in the capabilities. An older proxy doesn't say: no.
export function offersExt(camera: { capabilities?: { live?: readonly string[] } | null } | null | undefined): boolean {
  return !!camera?.capabilities?.live?.includes('ext');
}

// What a camera plays for the viewer's choice: main only where HEVC plays,
// ext only where the camera has it (and it started this visit); else sub.
export function effectiveQuality(choice: Quality, o: { hevc: boolean; ext: boolean }): Quality {
  if (choice === 'main') return o.hevc ? 'main' : 'sub';
  if (choice === 'ext') return o.ext ? 'ext' : 'sub';
  return 'sub';
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

// The live stream's label (the Live panel's info line), from the camera's
// current streams as its status reports them (the proxy's GetEnc): the main
// stream by its size, "4K" from 2160 lines, else "<height>p" (2560x1440:
// "1440p"; a camera's main need not be 4K, measured 2026-11-02). Main without
// a known stream: just "Main". The sub stream stays "SD". The ext stream is
// not in the camera's GetEnc (CX820): it is named by the playing picture's
// height (896x512: "512p"), "Mid" until that is known.
export function liveQualityLabel(quality: Quality, s: StreamInfo | null | undefined, videoHeight?: number): string {
  if (quality === 'ext') return videoHeight ? `${videoHeight}p` : 'Mid';
  if (quality !== 'main') return `SD ${s?.fps ?? 10} FPS`;
  if (!s) return 'Main';
  return `${s.height >= 2160 ? '4K' : `${s.height}p`} ${s.fps} FPS`;
}

export function badgeOf(playerState: PlayerState, stillsShowing: boolean): string {
  return playerState === 'playing' ? '● LIVE' : stillsShowing ? '● STILLS' : '● …';
}

// A camera whose address comes from its cam-proxy (Pi demo kit), before the
// proxy reported it.
export const WAITING_FOR_PROXY = "Waiting for the proxy to report the camera's address.";

// One explanation per error code: camera_error covers things re-trying
// won't fix (a certificate problem, an unexpected answer), so it points at
// the server logs instead of suggesting the camera is simply unreachable.
export function offlineReason(code: string | undefined): string {
  if (code === 'camera_offline') return 'The camera could not be reached.';
  if (code === 'camera_auth_failed') return 'Signing in to the camera failed.';
  if (code === 'camera_address_unknown') return WAITING_FOR_PROXY;
  if (code === 'unreachable') return "cams couldn't check the camera (network or server problem).";
  if (code === 'camera_credentials_missing') return 'cams has no password for this camera yet.';
  if (code === 'camera_unconfirmed') return "A change to the camera's connection data is waiting for an admin to confirm it.";
  if (code === 'camera_unverified_tls') return "cams can't verify the camera's certificate, so it doesn't send the password.";
  if (code === 'proxy_unreachable') return "The camera's cam-proxy could not be reached.";
  if (code === 'camera_untrusted') return "The cam-proxy doesn't trust the camera's certificate yet.";
  if (code === 'camera_cert_changed') return 'The camera now shows another certificate than the one trusted.';
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
  setQuality(get(liveUi).quality === 'main' ? 'sub' : 'main');
}

// The viewer's choice, kept for the next visit (cameras with three streams).
export function setQuality(quality: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, quality);
  } catch {
    // not persisted
  }
  liveUi.update((u) => ({ ...u, quality }));
}

// The ext stream of this camera didn't start: it plays sub for the rest of
// the visit (Mid shows as unavailable).
export function markExtFailed(cameraId: string): void {
  liveUi.update((u) => (u.extFailed?.includes(cameraId) ? u : { ...u, extFailed: [...(u.extFailed ?? []), cameraId] }));
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
