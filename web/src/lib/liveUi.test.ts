// web/src/lib/liveUi.test.ts
import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { badgeOf, checkLiveStatus, liveUi, offlineReason } from './liveUi';

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

describe('checkLiveStatus', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('checks the camera and shares its status', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 'cam1', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: 'cam-sim', streams: { main: null, sub: null } }), { status: 200 }));
    await checkLiveStatus('cam1');
    expect(get(liveUi).status).toMatchObject({ online: true, simulator: 'cam-sim' });
    expect(get(liveUi).checking).toBe(false);
  });
  it('drops a late answer for a camera switched away from', async () => {
    let first = true;
    vi.stubGlobal('fetch', async (url: string) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 20));
      }
      return new Response(JSON.stringify({ id: url.includes('cam1') ? 'cam1' : 'cam2', online: true }), { status: 200 });
    });
    const slow = checkLiveStatus('cam1');
    await checkLiveStatus('cam2');
    await slow;
    expect(get(liveUi).status?.id).toBe('cam2');
  });
});
