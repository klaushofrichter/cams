# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Added

- Video page, Pan & tilt: a click on the word **Focus** makes the camera focus by itself, like the Reolink app's Autofocus button (cameras that can, such as the E1 Outdoor Pro; needs cam-proxy with `ptz/autofocus`). The word blinks while the camera focuses, about 4 s. New `POST /api/cameras/:id/ptz/autofocus` for every member.

### Changed

- The Lighthouse check (the daily live check and the production checks) now runs Lighthouse once to warm up before the three scored runs: on GitHub's machines the first run often scored 77–86 where the next ones scored 94 and more, and could fail the check on its own.

