import { describe, expect, it, vi } from 'vitest';
import { isPlainClick, spaNavigate } from './plainClick';
import { navigate } from './router';

vi.mock('./router', () => ({ navigate: vi.fn() }));

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

// /simplify 2026-11-17: the in-app links' one click handler.
describe('spaNavigate', () => {
  const click = (init: Partial<MouseEvent> = {}) => {
    const e = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, ...init } as MouseEvent;
    e.preventDefault = vi.fn();
    return e;
  };
  it('navigates on a plain click and says so', () => {
    const e = click();
    expect(spaNavigate(e, '/app/video?cam=den')).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/app/video?cam=den');
  });
  it('leaves any other click to the browser', () => {
    vi.mocked(navigate).mockClear();
    const e = click({ metaKey: true });
    expect(spaNavigate(e, '/app/video')).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
