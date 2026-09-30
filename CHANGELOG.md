# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Recordings in progress: events of one recording show as one "recording…" entry naming each kind (Live panel and History's list). The camera extends a recording while events keep coming, so events at most 20 s after the previous one are grouped (measured on cam1: one clip's events ≤ 25 s apart, consecutive clips' ≥ 22 s).

