// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import TopBar from './TopBar.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

// Code review 2026-11-14: an Alt-click (download) or a click already handled
// stays the browser's; only a plain click navigates in the app.
describe('TopBar brand link', () => {
  it('leaves Alt-clicks and handled clicks to the browser', () => {
    component = mount(TopBar, { target: document.body });
    flushSync();
    const brand = document.querySelector<HTMLAnchorElement>('[data-testid="brand-link"]')!;
    const fire = (init: MouseEventInit, handled = false) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      if (handled) e.preventDefault();
      // jsdom does not navigate; a pending navigation would only log.
      brand.dispatchEvent(e);
      return e;
    };
    expect(fire({ altKey: true }).defaultPrevented).toBe(false);
    const before = location.href;
    fire({}, true);
    expect(location.href).toBe(before);
    expect(fire({}).defaultPrevented).toBe(true);
  });
});
