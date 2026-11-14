import { afterEach, describe, expect, it } from 'vitest';
import { intEnv } from '../server/env';

afterEach(() => void delete process.env.CAMS_TEST_INT);

describe('intEnv', () => {
  const set = (v: string) => void (process.env.CAMS_TEST_INT = v);
  it('reads a whole number within the bounds', () => {
    set('42');
    expect(intEnv('CAMS_TEST_INT', 7)).toBe(42);
    set('0');
    expect(intEnv('CAMS_TEST_INT', 7, { min: 0 })).toBe(0);
  });
  it('falls back to the default when unset, empty, not whole, or out of bounds', () => {
    expect(intEnv('CAMS_TEST_INT', 7)).toBe(7);
    for (const v of ['', ' ', 'abc', '1.5', '-3', '0', '1e400']) {
      set(v);
      expect(intEnv('CAMS_TEST_INT', 7)).toBe(7);
    }
    set('500');
    expect(intEnv('CAMS_TEST_INT', 7, { max: 100 })).toBe(7);
  });
});
