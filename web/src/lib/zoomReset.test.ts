import { describe, expect, it } from 'vitest';
import { PLAYER_MOVES, resetsZoom, zoomKey } from './zoomReset';

// When the Video player's pinch zoom goes back to 1x (Klaus, 2026-11-05): a
// moment the viewer picks starts at 1x; playback, stepping and scrubbing
// keep the zoom, whatever the picture is (the next clip, stills, live).
describe('resetsZoom', () => {
  it('keeps the zoom while playing on, and when the picture changes under it', () => {
    for (const m of ['play', 'next-clip', 'stills', 'catch-up'] as const) expect(resetsZoom(m), m).toBe(false);
  });

  it('keeps it for steps and scrubbing', () => {
    for (const m of ['skip', 'event-step', 'scrub'] as const) expect(resetsZoom(m), m).toBe(false);
  });

  it('resets it for a picked moment: a thumbnail, an event, a day, a camera, a link, back to live', () => {
    for (const m of ['thumbnail', 'event', 'day', 'camera', 'link', 'live'] as const) expect(resetsZoom(m), m).toBe(true);
  });

  it('has a rule for every move', () => {
    for (const m of PLAYER_MOVES) expect(typeof resetsZoom(m)).toBe('boolean');
  });
});

describe('zoomKey', () => {
  it('changes with the camera and with each pick, and nothing else', () => {
    expect(zoomKey('den', 0)).toBe(zoomKey('den', 0));
    expect(zoomKey('den', 1)).not.toBe(zoomKey('den', 0));
    expect(zoomKey('barn', 0)).not.toBe(zoomKey('den', 0));
  });
});
