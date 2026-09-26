# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


- Fix: Settings saves write the camera's complete current settings object with only your changes, so nothing else is reset (the firmware resets keys a save leaves out). Unexpected changes are logged.
