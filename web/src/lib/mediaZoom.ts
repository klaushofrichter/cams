// The maths of zooming a picture inside its frame (lib/pinchZoom.ts is the
// touch handling). A view maps a point p of the picture at 1x, in the frame's
// coordinates, to p * s + (x, y) on screen. Pure, in CSS pixels.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
// A pinch that ends this close to 1x means 1x.
export const SNAP_BELOW = 1.05;

export interface View {
  s: number;
  x: number;
  y: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export type Rect = Point & Size;

export const IDENTITY: View = { s: 1, x: 0, y: 0 };

export const clampScale = (s: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

// One step of two fingers: scale by their spread, around the point between
// them, and follow that point as it moves.
export function pinchStep(v: View, prev: [Point, Point], next: [Point, Point]): View {
  const spread = ([a, b]: [Point, Point]) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = ([a, b]: [Point, Point]): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const before = spread(prev);
  const s = before > 0 ? clampScale((v.s * spread(next)) / before) : v.s;
  const k = s / v.s;
  const m0 = mid(prev);
  const m1 = mid(next);
  return { s, x: m1.x - (m0.x - v.x) * k, y: m1.y - (m0.y - v.y) * k };
}

// Where the picture's start lands on one axis. Larger than the frame: its
// edges stop at the frame's. Smaller: no room to pan, it keeps its share of the
// margin (centred if it is laid out centred, so a letterboxed picture stays in
// the middle while it grows).
function clampAxis(offset: number, s: number, start: number, len: number, frame: number): number {
  const scaled = s * len;
  const at = scaled > frame
    ? Math.min(0, Math.max(frame - scaled, offset + s * start))
    : len < frame ? (start * (frame - scaled)) / (frame - len) : start;
  return at - s * start;
}

// `picture`: where the picture is drawn in the frame at 1x (a letterbox's
// bars aren't picture).
export function clampView(v: View, frame: Size, picture: Rect): View {
  if (v.s <= MIN_ZOOM) return IDENTITY;
  return { s: v.s, x: clampAxis(v.x, v.s, picture.x, picture.w, frame.w), y: clampAxis(v.y, v.s, picture.y, picture.h, frame.h) };
}

export function panBy(v: View, dx: number, dy: number, frame: Size, picture: Rect): View {
  return clampView({ s: v.s, x: v.x + dx, y: v.y + dy }, frame, picture);
}

export const settled = (v: View): View => (v.s < SNAP_BELOW ? IDENTITY : v);

// The picture of a natural size inside its element's box, as object-fit: contain draws it.
export function containRect(box: Rect, naturalW: number, naturalH: number): Rect {
  if (!(naturalW > 0 && naturalH > 0)) return box;
  const k = Math.min(box.w / naturalW, box.h / naturalH);
  const w = naturalW * k;
  const h = naturalH * k;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

const px = (n: number) => Math.round(n * 1000) / 1000;
export const viewTransform = (v: View): string | null => (v.s === MIN_ZOOM ? null : `matrix(${v.s}, 0, 0, ${v.s}, ${px(v.x)}, ${px(v.y)})`);
