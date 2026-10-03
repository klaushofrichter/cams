# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Fewer background requests: concurrent History strip edge requests share one server-side lookup, the edge is not polled while the tab is hidden, and the once-a-minute today refresh no longer re-reads the neighbouring months' day lists. Otherwise an internal cleanup with no visible change (and cams now requires a cam-proxy with the day list's `date=`, v2026.10.02.4 or later).
