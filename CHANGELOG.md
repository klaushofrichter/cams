# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- History strip: ⇤ ‹ › ⇥ buttons go to the oldest recording, one window back
  or forward, and now; the playhead never moves past now or before the oldest
  content (the camera's SD card or its cam-proxy, `GET /api/cameras/:id/extent`).
- The line under the video names the time, the source and why a clip was
  recorded (`08:33:10 PM · SD 10 FPS · Person`); the corner badge is gone.
- Dark theme: stretches with stills are clearly lighter on the strip.

