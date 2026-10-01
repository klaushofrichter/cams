// Moves an element to the end of <body> while it is mounted: a dialog opened
// from inside a card <button> must not be nested in it (invalid HTML, and the
// card would see its clicks). Use it on a component's single root element.
export function portal(node: HTMLElement): { destroy: () => void } {
  document.body.appendChild(node);
  return { destroy: () => node.remove() };
}
