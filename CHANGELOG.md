# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Added
- Several cameras can share one cam-proxy (a multi-camera host): cams keeps one event stream per proxy and gives each camera its own events.
- `scripts/cameras-config.ts` writes `cameras.json` from a short list of cam-proxies (dry run by default, `--write`, `--prune`), checking a proxy's site CA against its pinned fingerprint.

