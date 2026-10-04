# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


### Fixed

- A still check or a new Vision analysis of a past day now updates that day's cards on the Video page (badge and thumbnail) and on the Timeline right away, also when you come back to the Video page; before, the card kept "Vision: not confirmed" until a browser reload.
