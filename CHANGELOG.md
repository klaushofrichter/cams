# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- The live view's quality label now follows the camera's current main stream: "4K" only for a 4K stream, otherwise its height, such as "1440p 25 FPS" or "1296p 15 FPS" (it said "4K" whatever the camera streamed). The camera's status is read again each time the live stream starts, so the label catches up after the camera changes its streams and restarts. Recordings and their labels are unchanged.

