// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, currentTheme, setTheme, toggleTheme } from './theme';

function stubPrefersLight(light: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('light') ? light : false }));
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
  stubPrefersLight(false);
});
afterEach(() => vi.unstubAllGlobals());

describe('theme', () => {
  it('defaults to the system preference', () => {
    expect(currentTheme()).toBe('dark');
    stubPrefersLight(true);
    expect(currentTheme()).toBe('light');
  });

  it('prefers the stored choice over the system', () => {
    stubPrefersLight(true);
    localStorage.setItem(THEME_KEY, 'dark');
    expect(currentTheme()).toBe('dark');
  });

  it('toggles, applies to <html> and persists', () => {
    expect(toggleTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(toggleTheme()).toBe('dark');
  });

  // Review focus 3: blocked storage must not break theming.
  it('works when localStorage throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    vi.stubGlobal('localStorage', throwing);
    expect(currentTheme()).toBe('dark');
    expect(() => setTheme('light')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
