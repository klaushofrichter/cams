// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { persistedBoolean } from './stores';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('persistedBoolean', () => {
  it('starts from the initial value and persists changes', () => {
    const s = persistedBoolean('k1', false);
    expect(get(s)).toBe(false);
    s.set(true);
    expect(localStorage.getItem('k1')).toBe('1');
    expect(get(persistedBoolean('k1', false))).toBe(true);
  });

  // Review focus 3: blocked storage falls back to the initial value.
  it('falls back to the initial value when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    const s = persistedBoolean('k2', false);
    expect(get(s)).toBe(false);
    expect(() => s.set(true)).not.toThrow();
    expect(get(s)).toBe(true);
  });
});
