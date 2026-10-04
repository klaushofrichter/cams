# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Changed

- **Live and History are one page, Video** (`/app/video`). The mode follows the player: at now it is live, moved back it plays the recording of that time, and a badge on the player says `● LIVE` or `REC 14:03:22`; ⇥ or a click on the badge is live again. One menu entry, "Video". Old `/app/live` and `/app/recordings` links still work.
- The Video sidebar: the camera card (the name links to the camera's web page, a small "Proxy" link, a status dot; a rename shows at once), the controls (sound, SD/4K, light, snapshot, fullscreen; SD/4K and the light work live only), the event filter and the day's events by hour. The Live/History tabs and the "Most recent events" list are gone; model and firmware are on Settings.
- The snapshot works in a recording too: it saves the frame on screen (the clip's frame or the still). Snapshot files are named `…-live-…`, `…-rec-…` or `…-still-…`.
- "Open in History" is "Open in Video".

