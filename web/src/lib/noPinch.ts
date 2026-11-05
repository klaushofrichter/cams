// The page doesn't zoom (a camera picture does, inside its frame: pinchZoom.ts,
// by touch events, which this doesn't stop). iOS ignores `user-scalable=no` in the viewport tag, so
// its browsers (Chrome on an iPhone is one) need this to refuse a pinch; theme.css
// has `touch-action` for the same. `maximum-scale=1` keeps iOS from zooming
// in when a field smaller than 16px gets the focus.
export function noPinch(target: EventTarget = document): void {
  const refuse = (e: Event) => e.preventDefault();
  for (const type of ['gesturestart', 'gesturechange']) target.addEventListener(type, refuse, { passive: false });
}
