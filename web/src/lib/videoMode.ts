import { get } from 'svelte/store';
import { snapshotName, triggerDownload } from './download';
import { apiFetch } from './api';
import { liveUi, type LiveUi } from './liveUi';
import { localClock } from './clock';
import { localDate } from './recordings';

// The Video page (spec 2026-10-04): one page, and its mode follows the
// player. Glued to now it is live; anywhere else it plays the recording (a
// clip, the proxy's stills or the preview tiles) of that time.
export type Mode = 'live' | 'rec';

export const modeOf = (glued: boolean): Mode => (glued ? 'live' : 'rec');

// Light and quality act on the live stream only.
export const LIVE_ONLY = 'Only in live mode';

// The snapshot where the player shows nothing (a gap, "No recording").
export const NOTHING_TO_SAVE = 'Nothing to save here.';

// The badge in live mode says what the stream does: LIVE only while live
// video plays (review of #173), STILLS over the proxy's stills, else
// Connecting… or Offline.
export function liveBadge(u: Pick<LiveUi, 'playerState' | 'stillsShowing' | 'status'>): string {
  if (u.status && !u.status.online) return 'Offline';
  if (u.playerState === 'playing') return '● LIVE';
  if (u.stillsShowing) return '● STILLS';
  return 'Connecting…';
}

// What a recording shows (Klaus, 2026-10-04): a clip by the stream that
// plays (sub SD, main 4K), or the proxy's stills.
export type RecShown = 'SD' | '4K' | 'Still';
export const clipShown = (stream: 'sub' | 'main'): RecShown => (stream === 'main' ? '4K' : 'SD');

// The badge on the player: "● LIVE", or "REC 14:03:22 · SD" (with the day
// when it isn't today: "REC Oct 3, 14:03:22 · Still"); nothing after the
// time where the player shows neither (preview tiles, a gap).
export function modeBadge(mode: Mode, at: number, now: number = Date.now(), shown: RecShown | null = null): string {
  if (mode === 'live') return '● LIVE';
  const d = new Date(at);
  const day = localDate(d) === localDate(new Date(now)) ? '' : `${d.toLocaleDateString(undefined, { month: 'short' })} ${d.getDate()}, `;
  return `REC ${day}${localClock(at)}${shown ? ` · ${shown}` : ''}`;
}

export { snapshotName, type SnapshotKind } from './download';

// What the player shows while it plays a recording.
export type PlayerFrame =
  | { kind: 'clip'; video: HTMLVideoElement; at: number }
  | { kind: 'still'; url: string; at: number }
  // A preview tile: its part of the minute's sprite.
  | { kind: 'tile'; url: string; sx: number; sy: number; w: number; h: number; at: number };

export interface PlayerHandle {
  frame(): PlayerFrame | null;
  fullscreen(): void;
}

// StripPlayer registers itself while it is mounted (one per page).
let player: PlayerHandle | null = null;
export function registerPlayer(p: PlayerHandle): () => void {
  player = p;
  return () => {
    if (player === p) player = null;
  };
}
export function currentPlayer(): PlayerHandle | null {
  return player;
}

const JPEG_QUALITY = 0.92;

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/jpeg', JPEG_QUALITY));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed'));
    img.src = url;
  });
}

// The frame as a JPEG. A clip's frame is drawn at the clip's own size (same
// origin, so the canvas isn't tainted); a still is the file itself; a
// preview tile is cut from its sprite.
export async function frameBlob(frame: PlayerFrame): Promise<Blob> {
  if (frame.kind === 'still') {
    const res = await apiFetch(frame.url);
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error(String(res.status));
    return res.blob();
  }
  const canvas = document.createElement('canvas');
  const ctx = (w: number, h: number) => {
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d');
    if (!c) throw new Error('no canvas');
    return c;
  };
  if (frame.kind === 'clip') {
    const v = frame.video;
    if (!v.videoWidth || !v.videoHeight || v.readyState < 2) throw new Error('no frame yet');
    ctx(v.videoWidth, v.videoHeight).drawImage(v, 0, 0);
  } else {
    const img = await loadImage(frame.url);
    ctx(frame.w, frame.h).drawImage(img, frame.sx, frame.sy, frame.w, frame.h, 0, 0, frame.w, frame.h);
  }
  return canvasBlob(canvas);
}

// The recording's snapshot button: what the player shows, saved as a JPEG.
// Busy and the error line are the live snapshot's (liveUi).
export async function saveRecordingSnapshot(cam: string): Promise<void> {
  if (get(liveUi).snapshotBusy) return;
  const frame = player?.frame() ?? null;
  if (!frame) {
    liveUi.update((u) => ({ ...u, snapshotError: NOTHING_TO_SAVE }));
    return;
  }
  liveUi.update((u) => ({ ...u, snapshotBusy: true, snapshotError: '' }));
  try {
    const blob = await frameBlob(frame);
    const url = URL.createObjectURL(blob);
    triggerDownload(url, snapshotName(cam, frame.kind === 'clip' ? 'rec' : 'still', frame.at));
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    liveUi.update((u) => ({ ...u, snapshotError: "The snapshot couldn't be saved. The picture may still be loading." }));
  } finally {
    liveUi.update((u) => ({ ...u, snapshotBusy: false }));
  }
}
