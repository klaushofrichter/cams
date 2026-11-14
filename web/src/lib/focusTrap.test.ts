// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { focusables, trapTab } from './focusTrap';

afterEach(() => (document.body.innerHTML = ''));

describe('focusTrap', () => {
  it('lists the enabled matches and wraps Tab and Shift+Tab around them', () => {
    document.body.innerHTML = '<div id="d"><button id="a">a</button><button disabled>x</button><input id="b"><a id="c" href="#">c</a></div>';
    const el = document.getElementById('d')!;
    const list = () => focusables(el, 'button, input, a[href]');
    expect(list().map((e) => e.id)).toEqual(['a', 'b', 'c']);
    const tab = (shiftKey = false) => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
      trapTab(e, list);
      return e.defaultPrevented;
    };
    document.getElementById('c')!.focus();
    expect(tab()).toBe(true);
    expect(document.activeElement!.id).toBe('a');
    expect(tab(true)).toBe(true);
    expect(document.activeElement!.id).toBe('c');
    const other = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    trapTab(other, list);
    expect(other.defaultPrevented).toBe(false);
  });
  it('leaves Tab alone when there is nothing to focus', () => {
    const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    trapTab(e, () => []);
    expect(e.defaultPrevented).toBe(false);
  });
});
