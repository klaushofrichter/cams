// web/src/lib/compose.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composedName, formatLength, isAvailable, resultLength } from './compose';

describe('compose helpers', () => {
  it('computes the result length and its limits', () => {
    expect(resultLength(20, 0, 0)).toEqual({ ok: true, seconds: 20 });
    expect(resultLength(20, 10, 30)).toEqual({ ok: true, seconds: 60 });
    expect(resultLength(20, 10, 31)).toEqual({ ok: false, error: 'At most 1:00' });
    expect(resultLength(20, -10, -10)).toEqual({ ok: false, error: 'At least 1 s of the clip must remain' });
    expect(resultLength(20, 61, 0)).toEqual({ ok: false, error: 'Whole seconds from -600 to 60' });
    expect(resultLength(20, 1.5, 0)).toEqual({ ok: false, error: 'Whole seconds from -600 to 60' });
  });
  it('formats lengths and file names', () => {
    expect(formatLength(52)).toBe('0:52');
    expect(formatLength(60)).toBe('1:00');
    // The camera's local time, from the event id, like the original download (issue #72).
    expect(composedName('den', '20260928-140000-140020', 'sd')).toBe('den-2026-09-28_14-00-00-composed-sd.mp4');
  });
});

describe('isAvailable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true when cams could not ask the proxy (502), false only when it says so (issue #76)', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"proxy_unavailable"}', { status: 502 }));
    expect(await isAvailable('den', '20260928-140000-140020')).toBe(true);
    vi.stubGlobal('fetch', async () => new Response('{"available":false}', { status: 200 }));
    expect(await isAvailable('den', '20260928-140000-140020')).toBe(false);
  });
});
