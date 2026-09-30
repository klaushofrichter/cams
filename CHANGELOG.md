# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Fix: the light button needed two clicks. The camera reports the light's new state 1–3 s late, and cams read it back at once and called the switch not applied; it now waits for the new state (5 s at most).

