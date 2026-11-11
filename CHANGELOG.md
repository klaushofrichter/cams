# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Fixed
- Phone: leaving fullscreen with a double tap no longer presses what is under your finger afterwards. On a slow phone, the second tap could open the Timeline through the "Show in Timeline" link.
- The start page's scripts, stylesheets, screenshots and icons no longer count against the visitor's page limit, so browsing the public pages never ends in "too many requests" for the page's own files. They have their own, much larger limit.

