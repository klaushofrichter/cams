# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Live video from the camera: low-latency player, HD where the browser supports it, mute, snapshot, fullscreen, and an offline state with retry. The stream renews itself every 9 minutes without a visible cut.
