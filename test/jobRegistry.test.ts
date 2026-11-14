import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRegistry } from '../server/jobRegistry';

afterEach(() => vi.useRealTimers());

describe('JobRegistry', () => {
  it('finds a job only in the scope it was started in, with its extra fields', () => {
    const r = new JobRegistry<{ by: string }>(1000);
    r.remember('a/cam', 'job1', { by: 'x@example.com' });
    expect(r.lookup('a/cam', 'job1')).toMatchObject({ id: 'job1', by: 'x@example.com' });
    expect(r.lookup('b/cam', 'job1')).toBeUndefined();
    r.delete('a/cam', 'job1');
    expect(r.lookup('a/cam', 'job1')).toBeUndefined();
  });
  it('a lookup keeps a job; an unasked one is swept when the next job is remembered', () => {
    vi.useFakeTimers();
    const r = new JobRegistry(1000);
    r.remember('s', 'asked', {});
    r.remember('s', 'idle', {});
    vi.advanceTimersByTime(800);
    expect(r.lookup('s', 'asked')).toBeDefined();
    vi.advanceTimersByTime(800);
    r.remember('s', 'new', {});
    expect(r.lookup('s', 'idle')).toBeUndefined();
    expect(r.lookup('s', 'asked')).toBeDefined();
  });
});
