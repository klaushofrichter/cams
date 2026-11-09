# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Fixed
- Video page: after leaving the page while the player fills the screen (phones without fullscreen), one Back now returns to the recording at the moment last shown; it used to take an extra Back.
- cams-admin mode: when a cam-proxy refuses cams's admin token because its allow-list doesn't include admin tokens yet, cams tries again after 5 minutes, then 15, 30 and every hour (it used to wait a day or a restart), so the proxy sign-in link and camera renames work soon after the proxy allows it.

