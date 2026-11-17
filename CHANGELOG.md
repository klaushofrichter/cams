# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- CI (internal): the dependency audit is now two blocking steps. What ships (the production dependencies) has no exceptions. The full audit, development tools included, allows one advisory: picomatch GHSA-fc5q-39xc-vjpf (a slow pattern match, high), which reaches cams only through the build and test tools (vite, vitest) and has no fixed release yet; Klaus approved it on 2026-11-17. The check fails again once a picomatch release or a fix appears, so the exception gets removed.

### Changed

- Internal cleanup (/simplify, 2026-11-17), no visible change: a viewer-token session is checked once per request instead of twice (less work on every page and still refresh), and the last unbounded reads of cam-proxy and cams-admin answers are capped.

### Fixed

- A composed clip played in the browser no longer gets a stray byte-range header on a full answer, which could confuse seeking in Safari (code review 2026-11-17).
