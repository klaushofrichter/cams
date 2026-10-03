# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Fixed

- A day list waiting out a busy cam-proxy stops when the viewer leaves, instead of holding the request for up to 10 s.
- An older cam-proxy (one that answers 400 to `date=`) is remembered for 10 minutes per camera, so a cold day costs 2 requests instead of 4.

