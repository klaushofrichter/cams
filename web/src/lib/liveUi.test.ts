// web/src/lib/liveUi.test.ts
import { describe, expect, it } from 'vitest';
import { badgeOf, offlineReason } from './liveUi';

describe('liveUi helpers', () => {
  it('names the badge as the Live page did', () => {
    expect(badgeOf('playing', false)).toBe('● LIVE');
    expect(badgeOf('reconnecting', true)).toBe('● STILLS');
    expect(badgeOf('connecting', false)).toBe('● …');
  });
  it('explains each offline code', () => {
    expect(offlineReason('camera_offline')).toBe('The camera could not be reached.');
    expect(offlineReason('camera_auth_failed')).toBe('Signing in to the camera failed.');
    expect(offlineReason('unreachable')).toBe("cams couldn't check the camera (network or server problem).");
    expect(offlineReason('other')).toMatch(/server logs/);
  });
});
