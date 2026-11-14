# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Internal cleanup, no change to what you see: shared helpers replace repeated code across the server and the web app. Opening a day of recordings with new thumbnails does less disk work on the server, and the History view no longer re-asks for its time range on every tab switch.

