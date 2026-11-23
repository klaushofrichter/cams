# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- CI (internal): the full dependency audit no longer allows the picomatch advisory GHSA-fc5q-39xc-vjpf. GitHub withdrew it on 2026-11-18, so the allowlist is empty and every high advisory blocks again.

