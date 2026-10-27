// Motion for the landing page: scroll reveals, counters and the card
// spotlight. Everything is off under prefers-reduced-motion (and without
// IntersectionObserver): content then shows at once, in its final state.

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function canObserve(): boolean {
  return typeof IntersectionObserver === 'function' && !reducedMotion();
}

// Fades and lifts an element in when it scrolls into view (CSS: .rv, .rv.in).
// `delay` staggers siblings, in ms.
export function reveal(node: HTMLElement, delay = 0) {
  node.classList.add('rv');
  if (!canObserve()) {
    node.classList.add('in');
    return {};
  }
  if (delay) node.style.transitionDelay = `${delay}ms`;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        node.classList.add('in');
        io.disconnect();
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
  );
  io.observe(node);
  return { destroy: () => io.disconnect() };
}

// Counts a number up from 0 when it comes into view. The markup holds the
// final value, so without motion nothing changes.
export function countUp(node: HTMLElement, opts: { value: number; suffix?: string }) {
  if (!canObserve() || opts.value < 2) return {};
  const suffix = opts.suffix ?? '';
  let frame = 0;
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 1200);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = `${Math.round(opts.value * eased)}${suffix}`;
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }, { threshold: 0.4 });
  node.textContent = `0${suffix}`;
  io.observe(node);
  return {
    destroy: () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

// A soft light that follows the pointer over a card (CSS reads --mx, --my).
export function spotlight(node: HTMLElement) {
  const move = (e: PointerEvent) => {
    const r = node.getBoundingClientRect();
    node.style.setProperty('--mx', `${e.clientX - r.left}px`);
    node.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  node.addEventListener('pointermove', move);
  return { destroy: () => node.removeEventListener('pointermove', move) };
}
