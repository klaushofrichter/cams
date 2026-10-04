# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Timeline: under the large still, ◀ 1 s and 1 s ▶ (and the ← → keys while it is open) step one second back or forward. A step moves the minute selection into the next or previous minute, switches to the next or previous hour, and loads the next or previous day, but never past now or before the oldest still. A second without a still shows "YYYY-MM-DD HH:MM:SS not available as snapshot", and stepping goes on from there. Without a large still, ← → still step the minute (#159).
