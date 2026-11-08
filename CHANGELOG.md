# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Added

- Admin tokens: a token made as "admin" in cams-admin signs you in as an admin of its accounts (confirm changes, change settings). Other tokens stay viewer tokens. About now shows your role.

### Fixed

- Live works right after an admin confirms a new camera or proxy on the banner: the open page re-reads its camera list (and hears the new configuration when a camera is still waiting to be confirmed), so it no longer stays "Connecting…" until a page reload.

