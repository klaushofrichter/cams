# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- `scripts/create-camera-user.sh` now updates only cam1's entry in `cams-cameras` and keeps the other cameras (it used to rewrite the list with cam1 alone, which would have removed cam2).
- Tests use cam-sim v2026.09.27.1; the leftovers of the old mock camera are gone (generator scripts, mock names in the test code).
- README: the camera list, configuration, and how the tests use cam-sim.

