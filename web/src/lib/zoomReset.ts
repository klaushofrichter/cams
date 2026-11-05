// When the Video player's pinch zoom (lib/pinchZoom.ts) goes back to 1x
// (Klaus, 2026-11-05): a moment the viewer picks starts at 1x; playing on,
// stepping and scrubbing keep the zoom, whatever the picture turns into (the
// next clip, the stills standing in for a video, live after catching up).
// Another frame width (a rotation, fullscreen) resets it in pinchZoom itself.
export const PLAYER_MOVES = [
  // the picture changes under the zoom
  'play', // playback running on
  'next-clip', // playback into the next clip
  'stills', // stills standing in for the video, or the video back
  'catch-up', // playback reaching now: live
  // the viewer moves
  'skip', // ±1 s, ±10 s (buttons, keys, swipes, fullscreen taps)
  'event-step', // ⏮ / ⏭, [ ], PgUp/PgDn: the previous or next event
  'scrub', // the timeline dragged, clicked, scrolled, its ‹ › and ⇤
  // the viewer picks a moment
  'thumbnail', // a thumbnail under the timeline
  'event', // an event card
  'day', // the day picker
  'camera', // another camera
  'link', // a link, Back or Forward, "Open in History"
  'live', // ⇥, the REC badge: back to live
] as const;
export type PlayerMove = (typeof PLAYER_MOVES)[number];

const PICKS: ReadonlySet<PlayerMove> = new Set(['thumbnail', 'event', 'day', 'camera', 'link', 'live']);
export const resetsZoom = (m: PlayerMove): boolean => PICKS.has(m);

// pinchZoom's key: a new value resets to 1x. `picks` counts the picked moments.
export const zoomKey = (cam: string, picks: number): string => `${cam}|${picks}`;
