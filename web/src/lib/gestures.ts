import type { FsAction } from './playerFullscreen';

// Phone gestures in fullscreen (#182, spec 2026-10-04-fullscreen-recorded):
// one pointer stroke (touch or pen) is a swipe, a tap in a third of the
// player, or nothing. Thresholds are the spec's rulings.
export const SWIPE_MIN_PX = 40; // horizontal distance of a swipe
export const SWIPE_MAX_MS = 800;
export const EDGE_PX = 24; // a swipe from the screen edge is the system's (iOS Back)
export const TAP_MAX_PX = 12;
export const TAP_MAX_MS = 500;

// Client coordinates: where the stroke started and ended, how long it took,
// the player box (for the thirds) and the viewport (for the edges).
export interface Stroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ms: number;
  boxLeft: number;
  boxWidth: number;
  viewWidth: number;
}

export type Gesture = { kind: 'swipe'; dir: 'left' | 'right' } | { kind: 'tap'; zone: 'left' | 'middle' | 'right' };

export function classifyStroke(s: Stroke): Gesture | null {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const dist = Math.hypot(dx, dy);
  if (dist < TAP_MAX_PX) {
    if (s.ms > TAP_MAX_MS) return null; // a long press
    const third = (s.x0 - s.boxLeft) / (s.boxWidth / 3);
    return { kind: 'tap', zone: third < 1 ? 'left' : third < 2 ? 'middle' : 'right' };
  }
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy) || s.ms > SWIPE_MAX_MS) return null;
  if (s.x0 < EDGE_PX || s.x0 > s.viewWidth - EDGE_PX) return null;
  return { kind: 'swipe', dir: dx < 0 ? 'left' : 'right' };
}

// Swipe left / right: 1 s forward / back; a side third: 10 s; the middle: play/pause.
export function gestureAction(g: Gesture): FsAction {
  if (g.kind === 'swipe') return { kind: 'skip', ms: g.dir === 'left' ? 1000 : -1000 };
  if (g.zone === 'middle') return { kind: 'toggle' };
  return { kind: 'skip', ms: g.zone === 'left' ? -10_000 : 10_000 };
}

// A double tap: the second tap this soon after the first and this near it.
// One window for the picture's zoom (back to 1x), fullscreen and the middle
// third (Klaus, 2026-11-05: short).
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 30;

// The fullscreen picture's middle third: its single tap (play/pause) would
// fire twice, or flicker, under a double tap (leave fullscreen), so it waits
// for the window to pass; a second tap within it is the double tap instead.
export interface TapGate {
  tap(x: number, y: number, single: () => void, double: () => void): void;
  cancel(): void;
}
export function createTapGate(ms = DOUBLE_TAP_MS, px = DOUBLE_TAP_PX): TapGate {
  let waiting: { x: number; y: number; timer: ReturnType<typeof setTimeout>; single: () => void } | null = null;
  const cancel = () => {
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
  };
  return {
    tap(x, y, single, double) {
      const w = waiting;
      cancel();
      if (w && Math.hypot(x - w.x, y - w.y) <= px) return double();
      w?.single(); // a tap elsewhere: the waiting one was a single tap
      const timer = setTimeout(() => {
        waiting = null;
        single();
      }, ms);
      waiting = { x, y, timer, single };
    },
    cancel,
  };
}
