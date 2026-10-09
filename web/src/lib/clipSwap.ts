// web/src/lib/clipSwap.ts
// The Video page's player while the timeline is dragged into a clip (Klaus,
// 2026-10-09): the still layer stays until the clip's video can show the
// moment under the cursor. The video loads and seeks underneath, invisible;
// it takes over only with a presented frame within SWAP_TOLERANCE_S of the
// cursor, and during a drag only after the cursor has been inside the clip
// for SWAP_DWELL_MS. A video that failed never shows: the still stays.

export const SWAP_TOLERANCE_S = 0.5; // a still is one per second: half of it
export const SWAP_HOLD_S = 1; // once shown during a drag: one still interval before the still is back
export const SWAP_DWELL_MS = 200;

export interface SwapInput {
  want: { url: string; offsetS: number } | null; // the clip under the cursor and the offset into it
  slot: { url: string | null; presentedS: number | null; error: boolean }; // the active video: its src, its presented frame's time
  scrubbing: boolean; // the timeline is being dragged
  dwellMs: number; // how long the cursor has been inside this clip
  shown: boolean; // the video was on screen at the last decision
}

export function showClipVideo(s: SwapInput): boolean {
  const { want, slot } = s;
  if (!want || slot.url !== want.url || slot.error) return false;
  // Shown and nobody dragging: playback or a step. The element keeps its
  // last frame while it seeks or buffers, so it is never black here.
  if (s.shown && !s.scrubbing) return true;
  if (slot.presentedS === null) return false;
  const off = Math.abs(slot.presentedS - want.offsetS);
  if (off > (s.shown ? SWAP_HOLD_S : SWAP_TOLERANCE_S) + 1e-9) return false;
  return !s.scrubbing || s.shown || s.dwellMs >= SWAP_DWELL_MS;
}

// When the cursor entered the clip under it (null: not in a clip).
export interface Entered { id: string; since: number }
export function enterClip(prev: Entered | null, clipId: string | null, now: number): Entered | null {
  if (clipId === null) return null;
  return prev && prev.id === clipId ? prev : { id: clipId, since: now };
}

// Seeks while dragging: at most one in flight; a newer target replaces the
// one waiting, so a pointer move doesn't queue a seek.
export interface Seeker { inFlight: boolean; pending: number | null }
export const IDLE_SEEKER: Seeker = { inFlight: false, pending: null };
export function seekRequest(s: Seeker, target: number): { next: Seeker; seek: number | null } {
  if (s.inFlight) return { next: { inFlight: true, pending: target }, seek: null };
  return { next: { inFlight: true, pending: null }, seek: target };
}
export function seekSettled(s: Seeker): { next: Seeker; seek: number | null } {
  if (s.pending !== null) return { next: { inFlight: true, pending: null }, seek: s.pending };
  return { next: IDLE_SEEKER, seek: null };
}
