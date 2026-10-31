# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Camera login: saving a password for a camera with no user name in cams-admin is refused with a message saying to set the camera user there. Before, cams saved an entry without a user, and its next start refused the whole credentials file (the Pi's cams on 2026-10-31).

