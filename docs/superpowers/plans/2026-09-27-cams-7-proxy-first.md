# cams Plan 7: cam-proxy first — clips, thumbnails, scrub preview, live fallback

Klaus's decisions (2026-09-27): cams plays the proxy's clips first; the camera
uploads the sub stream by FTP (H.264, plays everywhere); cams uses the proxy's
stills for event thumbnails, a scrub preview on the Recordings timeline, and a
Live fallback.

For a camera with `proxy` (Plan 6), each feature falls back to today's
behaviour when the proxy has nothing or is down.

1. **Clips proxy-first** (`server/recordings/service.ts`):
   - `withClip` (video, and thumbnails that need the clip) takes the proxy
     clip containing the event's start before asking the camera;
   - `openDownload('sub')` does the same; `openDownload('main')` asks the
     camera first (full quality) and falls back to the proxy's sub clip;
   - `downloadsState` is `'proxy'` for a camera with a proxy.
   Tests: with a proxy clip the camera sees no download; without one, the
   camera serves as before; main download from the camera.
2. **Event thumbnails from stills** (`thumbnail()`): the proxy's still at the
   event's start + 2 s (first still in [start+2 s, start+12 s]), cached like
   today's; else today's clip + ffmpeg path. Test: no clip download, the
   still's bytes.
3. **Scrub preview** (`Timeline.svelte`, `lib/timeline.ts`): for a proxied
   camera, moving the pointer over the Recordings timeline shows that second's
   tile from the day's preview sprites (one list request per day, one sprite
   per minute, browser-cached). Tests: `previewAt()` unit test; e2e hover on
   Den shows the preview.
4. **Live fallback** (`GET /api/cameras/:id/still/latest.jpg`, `Live.svelte`):
   the proxy's newest still of the last 2 minutes; Live shows it, refreshed
   every second, while the live player isn't playing (connecting or
   reconnecting for over 5 s) or the camera is offline. Tests: route (auth,
   no proxy 404, newest still, none → 404); component-level check where
   practical.
5. Docs, CHANGELOG, whole-branch review, PR, release.
