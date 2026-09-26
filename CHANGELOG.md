# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


- Fix: clip playback, thumbnails and downloads failed on the real camera (it drops a Download whose source path is percent-encoded); one transfer at a time per camera, like the camera's own web UI.
