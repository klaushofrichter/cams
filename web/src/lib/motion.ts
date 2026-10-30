import { slide } from 'svelte/transition';

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Svelte transitions don't honour the media query by themselves.
export function duration(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

// A soft open and close: the height slides while the content fades (the
// PTZ panel; Klaus wants no hard cuts). Instant with reduced motion.
export function reveal(node: Element, o: { duration?: number } = {}) {
  const s = slide(node, { duration: duration(o.duration ?? 160) });
  return { ...s, css: (t: number, u: number) => `${s.css?.(t, u) ?? ''};opacity:${t}` };
}
