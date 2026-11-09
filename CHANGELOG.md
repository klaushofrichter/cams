# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


### Fixed

- MCP: search_recordings answers within about 40 seconds, with what it found so far marked as cut short.
- MCP: pictures read at most 32 MB from cams before scaling, and their ffmpeg runs share the thumbnails' limit of two at a time.
