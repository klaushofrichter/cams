// web/src/lib/liveUi.test.ts
import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { badgeOf, checkLiveStatus, keepAliveNote, liveUi, offlineReason, cameraKind, streamsText } from './liveUi';

describe('liveUi helpers', () => {
  it('names the badge as the Live page did', () => {
    expect(badgeOf('playing', false)).toBe('● LIVE');
    expect(badgeOf('reconnecting', true)).toBe('● STILLS');
    expect(badgeOf('connecting', false)).toBe('● …');
  });
  it('explains each offline code', () => {
    expect(offlineReason('camera_offline')).toBe('The camera could not be reached.');
    expect(offlineReason('camera_address_unknown')).toBe("Waiting for the proxy to report the camera's address.");
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

describe('keepAliveNote', () => {
  it('names every keep-alive choice', () => {
    expect(keepAliveNote(0)).toBe('The stream disconnects when you leave this page.');
    expect(keepAliveNote(30)).toBe('The stream stays connected for 30 s after you leave this page.');
    expect(keepAliveNote(60)).toBe('The stream stays connected for 1 min after you leave this page.');
    expect(keepAliveNote(120)).toBe('The stream stays connected for 2 min after you leave this page.');
    expect(keepAliveNote(300)).toBe('The stream stays connected for 5 min after you leave this page.');
    expect(keepAliveNote(900)).toBe('The stream stays connected for 15 min after you leave this page.');
  });
});

// Review of #173: what the Live panel said about the camera is on Settings now.
describe('camera kind and streams for Settings', () => {
  it('names a simulated camera with its version, else a camera', () => {
    expect(cameraKind({ id: 'c', online: true, simulator: 'cam-sim 2026.09.29.1' })).toBe('Simulated camera (cam-sim 2026.09.29.1)');
    expect(cameraKind({ id: 'c', online: true, simulator: null })).toBe('Camera');
    expect(cameraKind(null)).toBe('');
  });
  it('names the main and sub streams', () => {
    expect(streamsText({ id: 'c', online: true, streams: { main: { codec: 'h265', width: 4512, height: 2512, fps: 20 }, sub: { codec: 'h264', width: 896, height: 512, fps: 10 } } }))
      .toBe('Main H.265 4512×2512 @20 · Sub H.264 896×512 @10');
    expect(streamsText({ id: 'c', online: true })).toBe('');
  });
});
