import { describe, expect, it } from 'vitest';
import { liveUrl, retryDelayMs, snapshotUrl, supportsHevc, SWAP_AFTER_MS } from './live';

describe('live helpers', () => {
  it('swaps well inside the 600 s cluster limit', () => {
    expect(SWAP_AFTER_MS).toBe(9 * 60 * 1000);
  });

  it('backs off exponentially up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('detects HEVC support from MediaSource', () => {
    expect(supportsHevc((t) => t.includes('hvc1'))).toBe(true);
    expect(supportsHevc(() => false)).toBe(false);
  });

  it('builds URLs, encoding the camera id', () => {
    expect(liveUrl('cam1', 'main')).toBe('/api/cameras/cam1/live?quality=main');
    expect(snapshotUrl('a b')).toBe('/api/cameras/a%20b/snapshot.jpg');
  });
});
