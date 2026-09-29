// Brings `el` into view inside a scrolling parent no further out than
// `within` (inclusive), never the page (iPhone, 2026-09-29): on a phone the
// History list sits below the video in one scrolling content area, and
// scrolling that to a card moved the video off the screen. Returns whether a
// scrolling parent was found.
export function scrollIntoContainer(el: HTMLElement, within?: Element | null): boolean {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    const scrolls = (overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight;
    if (scrolls) {
      const box = p.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < box.top) p.scrollTop -= box.top - r.top;
      else if (r.bottom > box.bottom) p.scrollTop += r.bottom - box.bottom;
      return true;
    }
    if (p === within) break;
  }
  return false;
}
