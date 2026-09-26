# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- When the camera refuses recording downloads, cams stops asking (one check a minute), and Recordings says so with a banner instead of showing blank thumbnails. It recovers by itself when the camera does.
- A cancelled Google sign-in returns to the start page. Session tokens are pinned to HS256. Return paths with dot segments are rejected.
- Live explains when cams itself can't reach the camera. A failed snapshot shows a message instead of saving a broken file. The camera picker's arrow follows the theme.

