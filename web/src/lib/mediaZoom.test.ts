import { describe, expect, it } from 'vitest';
import { clampScale, clampView, containRect, IDENTITY, MAX_ZOOM, MIN_ZOOM, panBy, pinchStep, settled, viewTransform, type View } from './mediaZoom';

const frame = { w: 400, h: 225 };
const whole = { x: 0, y: 0, w: 400, h: 225 };
// A point of the picture (at 1x) on screen under a view.
const on = (v: View, px: number, py: number) => ({ x: v.x + v.s * px, y: v.y + v.s * py });

describe('scale limits', () => {
  it('stays between 1x and 5x', () => {
    expect(MIN_ZOOM).toBe(1);
    expect(MAX_ZOOM).toBe(5);
    expect(clampScale(0.2)).toBe(1);
    expect(clampScale(2.5)).toBe(2.5);
    expect(clampScale(9)).toBe(5);
  });
});

describe('pinchStep', () => {
  const finger = (x: number, y: number) => ({ x, y });

  it('scales by how much the fingers spread', () => {
    const v = pinchStep(IDENTITY, [finger(100, 100), finger(200, 100)], [finger(50, 100), finger(250, 100)]);
    expect(v.s).toBeCloseTo(2);
  });

  it('keeps the point between the fingers under the fingers', () => {
    const v = pinchStep(IDENTITY, [finger(120, 80), finger(180, 80)], [finger(90, 80), finger(210, 80)]);
    const p = on(v, 150, 80);
    expect(p.x).toBeCloseTo(150);
    expect(p.y).toBeCloseTo(80);
  });

  it('follows the fingers when both move together', () => {
    const start: View = { s: 2, x: -100, y: -50 };
    const v = pinchStep(start, [finger(100, 100), finger(200, 100)], [finger(130, 110), finger(230, 110)]);
    expect(v).toEqual({ s: 2, x: -70, y: -40 });
  });

  it('stops at 5x and at 1x, the focal point still under the fingers', () => {
    const big = pinchStep({ s: 4, x: -300, y: -100 }, [finger(100, 100), finger(200, 100)], [finger(0, 100), finger(300, 100)]);
    expect(big.s).toBe(5);
    const small = pinchStep({ s: 1.5, x: -50, y: -20 }, [finger(0, 100), finger(300, 100)], [finger(100, 100), finger(200, 100)]);
    expect(small.s).toBe(1);
  });

  it('survives two fingers on one point', () => {
    const v = pinchStep({ s: 2, x: -10, y: -10 }, [finger(100, 100), finger(100, 100)], [finger(100, 100), finger(150, 100)]);
    expect(v.s).toBe(2);
    expect(Number.isFinite(v.x)).toBe(true);
  });
});

describe('clampView', () => {
  it('at 1x is always the untouched picture', () => {
    expect(clampView({ s: 1, x: 40, y: -30 }, frame, whole)).toEqual(IDENTITY);
    expect(clampView({ s: 1, x: 40, y: -30 }, { w: 390, h: 844 }, { x: 0, y: 312, w: 390, h: 219 })).toEqual(IDENTITY);
  });

  it('keeps a picture that fills the frame covering it', () => {
    expect(clampView({ s: 2, x: 50, y: 10 }, frame, whole)).toEqual({ s: 2, x: 0, y: 0 });
    expect(clampView({ s: 2, x: -900, y: -900 }, frame, whole)).toEqual({ s: 2, x: -400, y: -225 });
    expect(clampView({ s: 2, x: -120, y: -60 }, frame, whole)).toEqual({ s: 2, x: -120, y: -60 });
  });

  it('keeps a letterboxed picture centred until it outgrows the frame on that axis', () => {
    // Fullscreen in portrait: a 16:9 picture in the middle of a tall screen.
    const f = { w: 390, h: 844 };
    const pic = { x: 0, y: 312.5, w: 390, h: 219 };
    const a = clampView({ s: 2, x: -100, y: 500 }, f, pic);
    expect(a.y + a.s * pic.y + (a.s * pic.h) / 2).toBeCloseTo(f.h / 2); // still centred
    expect(a.x).toBe(-100); // free across: the picture is wider than the screen
    // At 5x it is taller than the screen: its edges stop at the screen's.
    const b = clampView({ s: 5, x: 0, y: 900 }, f, pic);
    expect(b.y + b.s * pic.y).toBeCloseTo(0);
    const c = clampView({ s: 5, x: 0, y: -9000 }, f, pic);
    expect(c.y + c.s * (pic.y + pic.h)).toBeCloseTo(f.h);
  });

  it('keeps a picture at the frame\'s top where it is laid out there', () => {
    const pic = { x: 0, y: 0, w: 390, h: 219 };
    const v = clampView({ s: 1.5, x: 0, y: 200 }, { w: 390, h: 844 }, pic);
    expect(v.y).toBeCloseTo(0);
  });
});

describe('panBy', () => {
  it('moves with the finger, within the picture', () => {
    expect(panBy({ s: 2, x: -100, y: -50 }, 30, -20, frame, whole)).toEqual({ s: 2, x: -70, y: -70 });
    expect(panBy({ s: 2, x: -10, y: 0 }, 300, 0, frame, whole)).toEqual({ s: 2, x: 0, y: 0 });
  });
});

describe('settled', () => {
  it('a pinch ending close to 1x is 1x', () => {
    expect(settled({ s: 1.03, x: -5, y: -2 })).toEqual(IDENTITY);
    expect(settled({ s: 1.5, x: -5, y: -2 })).toEqual({ s: 1.5, x: -5, y: -2 });
  });
});

describe('containRect', () => {
  it('fits a picture in its box like object-fit: contain', () => {
    expect(containRect({ x: 0, y: 0, w: 390, h: 844 }, 1920, 1080)).toEqual({ x: 0, y: (844 - 219.375) / 2, w: 390, h: 219.375 });
    expect(containRect({ x: 0, y: 0, w: 400, h: 225 }, 4, 3)).toEqual({ x: (400 - 300) / 2, y: 0, w: 300, h: 225 });
  });

  it('takes the box itself without a known picture size', () => {
    expect(containRect({ x: 1, y: 2, w: 400, h: 225 }, 0, 0)).toEqual({ x: 1, y: 2, w: 400, h: 225 });
  });
});

describe('viewTransform', () => {
  it('is a matrix for the picture, nothing at 1x', () => {
    expect(viewTransform({ s: 2, x: -10, y: 5.5 })).toBe('matrix(2, 0, 0, 2, -10, 5.5)');
    expect(viewTransform(IDENTITY)).toBeNull();
  });
});
