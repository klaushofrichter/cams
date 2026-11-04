// Keeps the landing page's endless animations from running when nobody can
// see them (issue #327: on a Raspberry Pi they cost a third of all cores).
// A watched element runs while it is on screen and the visitor was active in
// the last 30 s. Otherwise it gets the class `motion-paused`, which the CSS
// turns into a pause; no per-frame work here. Without IntersectionObserver
// only the idle pause applies, and under reduced motion nothing runs anyway.
import { reducedMotion } from './landingMotion';

export const IDLE_MS = 30_000;
export const PAUSED_CLASS = 'motion-paused';
const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'];

type Watched = { visible: boolean; running: boolean; onChange?: (running: boolean) => void };

const watched = new Map<HTMLElement, Watched>();
let idle = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function apply(node: HTMLElement, w: Watched): void {
  const running = w.visible && !idle;
  if (running === w.running) return;
  w.running = running;
  node.classList.toggle(PAUSED_CLASS, !running);
  w.onChange?.(running);
}

function setIdle(value: boolean): void {
  idle = value;
  watched.forEach((w, node) => apply(node, w));
}

function onInput(): void {
  clearTimeout(timer);
  timer = setTimeout(() => setIdle(true), IDLE_MS);
  if (idle) setIdle(false);
}

const LISTEN = { capture: true, passive: true };

// A Svelte action. `onChange` is for a component with a timer of its own: it
// is told at once that the element runs, then every change, and false at the end.
export function runWhileUseful(node: HTMLElement, onChange?: (running: boolean) => void) {
  if (reducedMotion()) return {};
  if (watched.size === 0) {
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, LISTEN);
    onInput(); // Arrival counts as input: the page starts alive.
  }
  const w: Watched = { visible: true, running: !idle, onChange };
  watched.set(node, w);
  node.classList.toggle(PAUSED_CLASS, idle);
  onChange?.(w.running);
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          w.visible = entries[entries.length - 1].isIntersecting;
          apply(node, w);
        })
      : null;
  io?.observe(node);
  return {
    destroy() {
      io?.disconnect();
      watched.delete(node);
      onChange?.(false);
      if (watched.size > 0) return;
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, LISTEN);
      clearTimeout(timer);
      idle = false;
    },
  };
}
