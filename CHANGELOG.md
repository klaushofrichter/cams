# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Settings → Camera login: when this cams has no `CAMERA_CREDENTIALS_FILE` set (the Pi until 2026-10-26), saving says to set it, instead of pointing to the cluster's Secret.

