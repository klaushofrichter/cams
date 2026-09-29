# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- History: dragging or jumping the player no longer asks for a still per second passed (one drag asked for 2,542 in a minute): stills load where the position settles, and the minute's sprite shows meanwhile.
- cam-proxy stills and sprites have their own rate-limit budget (`RATE_LIMIT_IMAGE_MAX`, default 20,000 per 5 min), apart from clip videos, thumbnails and downloads.
- Timeline: a tile whose sprite was refused tries again after 3, 6, 12 and 24 s instead of staying empty.
- A sprite or still the browser gave up on ends quietly instead of logging a 500.

- Save clip: pre- and post-roll (and "Mark still sections") are available only for SD. For other sizes they are dimmed, with a line saying so, and a composed copy is the clip alone, resized.

