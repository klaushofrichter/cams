import { afterEach, describe, expect, it } from 'vitest';
import { assertRequiredEnv } from '../server/config';

describe('assertRequiredEnv', () => {
  const saved = process.env.COOKIE_SECRET;
  afterEach(() => {
    process.env.COOKIE_SECRET = saved;
  });
  it('passes when everything is set', () => {
    expect(() => assertRequiredEnv()).not.toThrow();
  });
  it('names the missing variable', () => {
    delete process.env.COOKIE_SECRET;
    expect(() => assertRequiredEnv()).toThrow(/COOKIE_SECRET/);
  });
});
