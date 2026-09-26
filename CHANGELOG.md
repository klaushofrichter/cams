# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


- Fix: an event whose SD and full-quality copies end a few seconds apart showed as two recordings; a clip still being recorded showed with a 16-hour length. A clip fetch the camera resets is retried once.
