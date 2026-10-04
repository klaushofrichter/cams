// Stage 2 of the Video page (spec 2026-10-04): event-card thumbnails load
// only when (nearly) on screen, a few at a time. A busy day asked for every
// thumbnail at once, and each can cost the proxy a still lookup or a clip
// frame. A card scrolled past before its turn is dropped, so a fast scroll
// is no request storm. Without IntersectionObserver every image loads at once.
export const THUMB_ROOT_MARGIN = '300px 0px';
export const THUMB_CONCURRENCY = 4;
const SLOT_TIMEOUT_MS = 15_000; // an image that never answers frees its slot

export interface ThumbJob {
  start(done: () => void): void;
}

// A queue that runs at most `max` jobs; add() returns a cancel for a job
// that hasn't started yet.
export function createThumbQueue(max: number) {
  const waiting: ThumbJob[] = [];
  let active = 0;
  function pump() {
    while (active < max && waiting.length) {
      const job = waiting.shift()!;
      active++;
      let finished = false;
      job.start(() => {
        if (finished) return;
        finished = true;
        active--;
        pump();
      });
    }
  }
  return {
    add(job: ThumbJob): () => void {
      waiting.push(job);
      pump();
      return () => {
        const i = waiting.indexOf(job);
        if (i >= 0) waiting.splice(i, 1);
      };
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiting.length;
    },
  };
}

let queue = createThumbQueue(THUMB_CONCURRENCY);
let observer: IntersectionObserver | null = null;
const watchers = new Map<Element, (visible: boolean) => void>();
function observe(node: Element, onChange: (visible: boolean) => void): () => void {
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) watchers.get(e.target)?.(e.isIntersecting);
  }, { rootMargin: THUMB_ROOT_MARGIN });
  watchers.set(node, onChange);
  observer.observe(node);
  return () => {
    watchers.delete(node);
    observer?.unobserve(node);
  };
}

// use:lazySrc={url} on an <img>: its src is set once it is near the screen
// and the queue has room. Image errors still reach the img's onerror.
export function lazySrc(node: HTMLImageElement, src: string) {
  let url = src;
  if (typeof IntersectionObserver === 'undefined') {
    node.src = url;
    return { update(next: string) { node.src = url = next; }, destroy() {} };
  }
  let started = false;
  let cancel: (() => void) | null = null;
  let release: (() => void) | null = null;
  const unobserve = observe(node, (visible) => {
    if (started) return;
    if (visible && !cancel) {
      cancel = queue.add({
        start(done) {
          cancel = null;
          started = true;
          const timer = setTimeout(() => release?.(), SLOT_TIMEOUT_MS);
          release = () => {
            clearTimeout(timer);
            node.removeEventListener('load', release!);
            node.removeEventListener('error', release!);
            release = null;
            done();
          };
          node.addEventListener('load', release);
          node.addEventListener('error', release);
          node.src = url;
        },
      });
    } else if (!visible && cancel) {
      cancel(); // scrolled past before its turn
      cancel = null;
    }
  });
  return {
    update(next: string) {
      url = next;
      if (started) node.src = next;
    },
    destroy() {
      unobserve();
      cancel?.();
      release?.();
    },
  };
}

// Tests only: a fresh observer (for a stubbed IntersectionObserver) and queue.
export function resetLazyThumbs(): void {
  queue = createThumbQueue(THUMB_CONCURRENCY);
  observer?.disconnect();
  observer = null;
  watchers.clear();
}
