export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Svelte transitions don't honour the media query by themselves.
export function duration(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}
