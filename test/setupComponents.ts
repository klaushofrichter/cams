// Setup for the "components" vitest project (fix round 1, items 1-4): jsdom
// doesn't implement scrollIntoView, and both EventList and DownloadList call
// it unconditionally once a selected card is found, so every component test
// that mounts them needs this polyfilled up front rather than per test.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    // no-op: jsdom has no layout, so there's nothing to actually scroll.
  };
}

// Svelte's bind:clientWidth observes size with ResizeObserver, which jsdom
// lacks; a no-op stand-in (jsdom has no layout, so sizes stay 0).
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Svelte's transitions run through the Web Animations API (element.animate),
// which jsdom lacks: an animation that finishes at once (on the next
// microtask), so a transition's element comes and goes as without one.
if (typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animate() {
    const a = {
      onfinish: null as null | (() => void),
      currentTime: 0,
      cancel() {},
      finish() {},
      play() {},
      pause() {},
    };
    void Promise.resolve().then(() => a.onfinish?.());
    return a as unknown as Animation;
  };
}
// animate:flip asks for the running animations first.
if (typeof Element.prototype.getAnimations !== 'function') {
  Element.prototype.getAnimations = () => [];
}
