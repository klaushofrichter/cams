# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- **cam-proxy support** (optional, per camera, `proxy` in `cams-cameras`):
  - new events and clips appear at once, instead of after the next minute's poll;
  - a Timeline page with the day's stills, one tile per minute, event minutes marked;
  - recordings play from the proxy's clips when the camera refuses the download (the real camera does), with a note instead of the "unavailable" banner.
- `scripts/create-camera-user.sh` now updates only cam1's entry in `cams-cameras` and keeps the other cameras (it used to rewrite the list with cam1 alone, which would have removed cam2).
- Tests use cam-sim v2026.09.27.1; the leftovers of the old mock camera are gone (generator scripts, mock names in the test code).
- README: the camera list, configuration, and how the tests use cam-sim.

