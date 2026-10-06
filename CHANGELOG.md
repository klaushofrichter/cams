# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Changed
- Live: while the live view connects (opening it, switching cameras, a reconnect), a camera with a cam-proxy shows its newest still in the player if it is less than 60 s old, instead of a black box. Newer stills replace it, and live takes over once its first frame is on screen. In fullscreen the connecting bar over the stills sits above the controls, and "● STILLS" under the player is readable again.
