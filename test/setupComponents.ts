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
