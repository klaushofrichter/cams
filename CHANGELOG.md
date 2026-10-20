# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Fixed
- An offline camera now says why when cams has no password for it, when its connection change still needs an admin's confirmation, or when its certificate can't be verified, instead of the generic "certificate problem" text.

