import { TAP_MAX_MS, TAP_MAX_PX } from './gestures';
import { clampView, containRect, IDENTITY, panBy, pinchStep, settled, viewTransform, type Point, type Rect, type View } from './mediaZoom';
import { duration } from './motion';

// Pinch-to-zoom on a camera picture (Klaus, 2026-11-05). The page itself never
// zooms (lib/noPinch.ts): this zooms the picture inside its frame, so the
// layout, the buttons and the overlays stay where they are.
//
// The element with the action is the frame: it clips, and it gets
//   --media-zoom        the picture's transform (none at 1x)
//   --media-zoom-scale  the scale, for marks that keep their size on the picture
//   --media-zoom-t      how long a snap takes (0 otherwise; 0 with reduced motion)
// The pictures opt in by CSS, each where it is drawn, overlays staying out:
//   transform: var(--media-zoom, none); transform-origin: 0 0;
//   transition: transform var(--media-zoom-t, 0s);
//
// Touch events, not pointer events: the browser takes one finger for scrolling
// at 1x and then cancels its pointer, and only a non-passive touchmove can
// refuse it the two-finger stroke (iOS WebKit has no other way; its
// gesturestart is refused by noPinch, which doesn't stop touch events).
// The mouse and the desktop never come here.

export interface ZoomState {
  zoomed: boolean; // above 1x
  strokeTaken: boolean; // the current (or last) stroke was a pinch, a pan or a reset, not the page's or a tap
}
export interface PinchZoomOptions {
  key?: unknown; // a new value resets to 1x (another clip, camera, still)
  onchange?: (s: ZoomState) => void;
}

const touch = { passive: false } as const;
const SNAP_MS = 160;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 30;
// A touch on these is theirs. data-no-zoom: a bar of controls, gaps included.
const NOT_THE_PICTURE = 'button, a, input, select, textarea, label, [data-no-zoom]';

// The picture on top right now, if one says its size: a <video> or <img> that
// is showing. A sprite tile or an empty frame has none: the frame itself.
function pictureIn(frame: HTMLElement, w: number, h: number): Rect {
  const whole = { x: 0, y: 0, w, h };
  const all = [...frame.querySelectorAll<HTMLVideoElement | HTMLImageElement>('video, img')].reverse();
  for (const el of all) {
    const nw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const nh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (!nw || !nh || !el.offsetWidth) continue;
    const css = getComputedStyle(el);
    if (css.visibility !== 'visible' || css.opacity === '0') continue;
    let x = 0;
    let y = 0;
    // Layout offsets: a transform doesn't change them. The frame is positioned.
    for (let e: HTMLElement | null = el; e && e !== frame; e = e.offsetParent as HTMLElement | null) {
      x += e.offsetLeft;
      y += e.offsetTop;
    }
    // The layout size unrounded (offsetWidth rounds), a transform not included.
    return containRect({ x, y, w: parseFloat(css.width), h: parseFloat(css.height) }, nw, nh);
  }
  return whole;
}

export function pinchZoom(node: HTMLElement, options: PinchZoomOptions = {}) {
  let opts = options;
  let view: View = IDENTITY;
  let picture: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let taken = false;
  let last: ZoomState = { zoomed: false, strokeTaken: false };
  let snapTimer: ReturnType<typeof setTimeout> | undefined;

  // The stroke, from the first finger down to the last one up.
  let stroke: { x: number; y: number; t: number; tap: boolean } | null = null;
  let refused = false; // the page was already scrolling when it would have become ours
  let pair: [Point, Point] | null = null;
  let finger: Point | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;

  function report() {
    const next = { zoomed: view.s > 1, strokeTaken: taken };
    if (next.zoomed === last.zoomed && next.strokeTaken === last.strokeTaken) return;
    last = next;
    opts.onchange?.(next);
  }
  function settle() {
    clearTimeout(snapTimer);
    node.style.removeProperty('--media-zoom-t');
    if (view.s === 1) node.style.removeProperty('overflow');
  }
  function paint(snap = false) {
    const m = viewTransform(view);
    settle();
    const ms = snap ? duration(SNAP_MS) : 0;
    if (ms > 0) {
      node.style.setProperty('--media-zoom-t', `${ms}ms`);
      node.style.overflow = 'hidden'; // until the snap has ended
      snapTimer = setTimeout(settle, ms);
    }
    if (m) {
      node.style.setProperty('--media-zoom', m);
      node.style.setProperty('--media-zoom-scale', String(view.s));
      node.style.touchAction = 'none'; // one finger pans now, not the page
      node.style.overflow = 'hidden';
    } else {
      node.style.removeProperty('--media-zoom');
      node.style.removeProperty('--media-zoom-scale');
      node.style.removeProperty('touch-action');
    }
    report();
  }
  function set(next: View, snap = false) {
    view = next;
    paint(snap);
  }

  const frameBox = () => node.getBoundingClientRect();
  const isPicture = (t: EventTarget | null) => {
    if (!(t instanceof Element) || !node.contains(t)) return false;
    const other = t.closest(NOT_THE_PICTURE);
    return !other || !node.contains(other);
  };
  // The fingers that landed on the picture. Not by where they are now: a
  // layer under a finger may be gone by then (a still giving way to the video).
  let ours = new Set<number>();
  const fingersOf = (e: TouchEvent) => Array.from(e.touches).filter((t) => ours.has(t.identifier));
  const stillDown = (e: TouchEvent) => new Set(Array.from(e.touches).map((t) => t.identifier).filter((id) => ours.has(id)));
  // A touch's move and end events go to the element it started on, and if that
  // has left the page they don't bubble here: so they are listened for there.
  const followed = new Set<EventTarget>();
  function follow(t: EventTarget) {
    if (followed.has(t)) return;
    followed.add(t);
    t.addEventListener('touchmove', move as EventListener, touch);
    t.addEventListener('touchend', end as EventListener, touch);
    t.addEventListener('touchcancel', end as EventListener, touch);
  }
  function unfollow() {
    for (const t of followed) {
      t.removeEventListener('touchmove', move as EventListener);
      t.removeEventListener('touchend', end as EventListener);
      t.removeEventListener('touchcancel', end as EventListener);
    }
    followed.clear();
  }
  function asPoints(a: Touch, b: Touch): [Point, Point] {
    const box = frameBox();
    return [{ x: a.clientX - box.left, y: a.clientY - box.top }, { x: b.clientX - box.left, y: b.clientY - box.top }];
  }
  function measure() {
    const box = frameBox();
    picture = pictureIn(node, box.width, box.height);
  }
  function take() {
    taken = true;
    if (stroke) stroke.tap = false;
    report();
  }

  function start(e: TouchEvent) {
    const held = stillDown(e); // none: a new stroke, even if the last one's end never came here
    const added = Array.from(e.touches).filter((t) => !held.has(t.identifier) && isPicture(t.target));
    ours = new Set([...held, ...added.map((t) => t.identifier)]);
    const fingers = fingersOf(e);
    if (!fingers.length) return;
    if (!held.size) {
      unfollow();
      stroke = { x: fingers[0].clientX, y: fingers[0].clientY, t: Date.now(), tap: true };
      refused = false;
      taken = false;
      report();
      measure();
    }
    for (const t of fingers) follow(t.target);
    if (fingers.length === 1) {
      pair = null;
      finger = { x: fingers[0].clientX, y: fingers[0].clientY };
      return;
    }
    if (refused) return;
    if (!e.cancelable) {
      refused = true;
      return;
    }
    e.preventDefault();
    pair = asPoints(fingers[0], fingers[1]);
    finger = null;
    take();
  }

  function move(e: TouchEvent) {
    const fingers = fingersOf(e);
    if (!stroke || refused || !fingers.length) return;
    // Not ours to refuse any more: the browser is scrolling the page.
    if (!e.cancelable) {
      refused = true;
      return;
    }
    if (fingers.length >= 2) {
      e.preventDefault();
      const now = asPoints(fingers[0], fingers[1]);
      const box = frameBox();
      set(clampView(pinchStep(view, pair ?? now, now), { w: box.width, h: box.height }, picture));
      pair = now;
      return;
    }
    const f = fingers[0];
    const far = Math.hypot(f.clientX - stroke.x, f.clientY - stroke.y) >= TAP_MAX_PX;
    if (view.s === 1) {
      if (far) stroke.tap = false; // the page's scroll, no tap
      return;
    }
    e.preventDefault();
    const box = frameBox();
    const from = finger ?? { x: f.clientX, y: f.clientY };
    finger = { x: f.clientX, y: f.clientY };
    set(panBy(view, f.clientX - from.x, f.clientY - from.y, { w: box.width, h: box.height }, picture));
    if (far) take();
  }

  function end(e: TouchEvent) {
    if (!stroke) return;
    ours = stillDown(e);
    const fingers = fingersOf(e);
    if (fingers.length >= 2) {
      pair = asPoints(fingers[0], fingers[1]);
      return;
    }
    if (fingers.length === 1) {
      pair = null;
      finger = { x: fingers[0].clientX, y: fingers[0].clientY };
      return;
    }
    const s = stroke;
    stroke = null;
    unfollow();
    pair = null;
    finger = null;
    const near = settled(view);
    if (near !== view) set(near, true);
    if (e.type !== 'touchend' || !s.tap || Date.now() - s.t > TAP_MAX_MS || view.s === 1) return;
    const t = Date.now();
    if (lastTap && t - lastTap.t <= DOUBLE_TAP_MS && Math.hypot(s.x - lastTap.x, s.y - lastTap.y) <= DOUBLE_TAP_PX) {
      // Back to 1x. No click from this tap, and not a tap for anybody else.
      lastTap = null;
      if (e.cancelable) e.preventDefault();
      taken = true;
      set(IDENTITY, true);
      return;
    }
    lastTap = { x: s.x, y: s.y, t };
  }

  // A tap on a zoomed picture isn't an action on it (the Archive's video plays on a click).
  function click(e: Event) {
    if (view.s > 1 && isPicture(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // Another width (a rotation, fullscreen): the zoom meant another picture size.
  // Another height only: the same zoom, within the new edges.
  let width: number | null = null;
  const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    const box = frameBox();
    const changed = width !== null && box.width !== width;
    width = box.width;
    if (view.s === 1) return;
    if (changed) return set(IDENTITY);
    measure();
    set(clampView(view, { w: box.width, h: box.height }, picture));
  });
  resized?.observe(node);

  node.addEventListener('touchstart', start, touch);
  node.addEventListener('click', click, true);

  return {
    update(next: PinchZoomOptions = {}) {
      const again = next.key !== opts.key;
      opts = next;
      if (again && view.s !== 1) set(IDENTITY);
    },
    destroy() {
      resized?.disconnect();
      clearTimeout(snapTimer);
      unfollow();
      node.removeEventListener('touchstart', start);
      node.removeEventListener('click', click, true);
    },
  };
}
