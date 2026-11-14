import { describe, expect, it } from 'vitest';
import { isPlainClick } from './plainClick';

// Code review 2026-11-14: one check for the in-app links' clicks, so Alt
// (download), Ctrl, ⌘, Shift, middle clicks and clicks already handled stay
// the browser's.
describe('isPlainClick', () => {
  // The lib tests run in node: the fields isPlainClick reads, as a MouseEvent.
  const click = (init: Partial<MouseEvent> = {}, handled = false) =>
    ({ button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: handled, ...init }) as MouseEvent;
  it('is true for a plain left click', () => expect(isPlainClick(click())).toBe(true));
  it('is false with any modifier, another button, or a handled click', () => {
    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) expect(isPlainClick(click({ [mod]: true })), mod).toBe(false);
    expect(isPlainClick(click({ button: 1 }))).toBe(false);
    expect(isPlainClick(click({}, true))).toBe(false);
  });
});
