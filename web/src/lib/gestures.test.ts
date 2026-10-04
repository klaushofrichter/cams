import { describe, expect, it } from 'vitest';
import { classifyStroke, gestureAction, EDGE_PX, SWIPE_MIN_PX, TAP_MAX_PX, type Stroke } from './gestures';

// Phone gestures in fullscreen (#182, spec 2026-10-04-fullscreen-recorded):
// one stroke is a swipe, a tap in a third, or nothing.
const W = 844; // a phone in landscape
const stroke = (s: Partial<Stroke>): Stroke => ({ x0: 400, y0: 200, x1: 400, y1: 200, ms: 120, boxLeft: 0, boxWidth: W, viewWidth: W, ...s });

describe('classifyStroke', () => {
  it('reads a short still touch as a tap, by third', () => {
    expect(classifyStroke(stroke({ x0: 100, x1: 102 }))).toEqual({ kind: 'tap', zone: 'left' });
    expect(classifyStroke(stroke({ x0: W / 2, x1: W / 2 }))).toEqual({ kind: 'tap', zone: 'middle' });
    expect(classifyStroke(stroke({ x0: W - 100, x1: W - 100 }))).toEqual({ kind: 'tap', zone: 'right' });
  });

  it('measures the thirds in the box, not the window', () => {
    // A box from 100 to 400: 150 is its left third, 250 the middle, 350 the right.
    const box = { boxLeft: 100, boxWidth: 300 };
    expect(classifyStroke(stroke({ ...box, x0: 150, x1: 150 }))).toEqual({ kind: 'tap', zone: 'left' });
    expect(classifyStroke(stroke({ ...box, x0: 250, x1: 250 }))).toEqual({ kind: 'tap', zone: 'middle' });
    expect(classifyStroke(stroke({ ...box, x0: 350, x1: 350 }))).toEqual({ kind: 'tap', zone: 'right' });
  });

  it('is not a tap after a long press or a small drag', () => {
    expect(classifyStroke(stroke({ ms: 900 }))).toBeNull();
    expect(classifyStroke(stroke({ x1: 400 + TAP_MAX_PX + 5 }))).toBeNull(); // too far for a tap, too short for a swipe
  });

  it('reads a fast horizontal move as a swipe, by direction', () => {
    expect(classifyStroke(stroke({ x0: 500, x1: 500 - SWIPE_MIN_PX - 1 }))).toEqual({ kind: 'swipe', dir: 'left' });
    expect(classifyStroke(stroke({ x0: 300, x1: 420, y1: 230 }))).toEqual({ kind: 'swipe', dir: 'right' });
  });

  it('needs the minimum distance and a mostly horizontal move', () => {
    expect(classifyStroke(stroke({ x0: 400, x1: 400 + SWIPE_MIN_PX - 2 }))).toBeNull();
    expect(classifyStroke(stroke({ x0: 300, x1: 380, y1: 260 }))).toBeNull(); // 80 across, 60 down: not twice
    expect(classifyStroke(stroke({ y0: 50, y1: 300 }))).toBeNull(); // vertical: the system's
  });

  it('ignores a swipe that starts at a screen edge (iOS Back)', () => {
    expect(classifyStroke(stroke({ x0: EDGE_PX - 1, x1: 200 }))).toBeNull();
    expect(classifyStroke(stroke({ x0: W - EDGE_PX + 1, x1: W - 200 }))).toBeNull();
    expect(classifyStroke(stroke({ x0: EDGE_PX + 1, x1: 200 }))).toEqual({ kind: 'swipe', dir: 'right' });
  });

  it('ignores a slow drag', () => {
    expect(classifyStroke(stroke({ x0: 300, x1: 500, ms: 1500 }))).toBeNull();
  });
});

describe('gestureAction', () => {
  it('maps swipes to 1 s, the side thirds to 10 s and the middle to play/pause', () => {
    expect(gestureAction({ kind: 'swipe', dir: 'left' })).toEqual({ kind: 'skip', ms: 1000 });
    expect(gestureAction({ kind: 'swipe', dir: 'right' })).toEqual({ kind: 'skip', ms: -1000 });
    expect(gestureAction({ kind: 'tap', zone: 'left' })).toEqual({ kind: 'skip', ms: -10_000 });
    expect(gestureAction({ kind: 'tap', zone: 'right' })).toEqual({ kind: 'skip', ms: 10_000 });
    expect(gestureAction({ kind: 'tap', zone: 'middle' })).toEqual({ kind: 'toggle' });
  });
});

