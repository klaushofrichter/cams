# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


### Fixed
- Video page: when an admin confirms a held camera (on this page or anywhere else), an open page now leaves the "waiting for an admin to confirm" message and the stills, and starts live video without a reload.
