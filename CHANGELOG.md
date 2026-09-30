# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Live panel: up to five of today's events, newest on top (a recording in progress first), or "No events today"; the heading is "Most recent events".
- Live panel: the controls are icons with tooltips; the quality switch reads SD/4K (the line under the video says 4K too).
- Live panel: a light button shows the camera's manual light (spotlight) and switches it on and off (`GET/PUT /api/cameras/:id/light`, `WhiteLed.state`, measured on cam1).
- The live event notice in the top bar shows for 1.5 s before it fades (was 1 s).
- Timeline: "Show in timeline grid" scrolls to the open minute, which now has a red frame, 3× thicker.
- History: "Show in Timeline" in the line under the video (cameras with a cam-proxy) opens the Timeline at that moment, scrolled to its framed minute.

