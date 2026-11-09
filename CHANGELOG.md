# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


### Fixed

- MCP: search_recordings answers within about 40 seconds, with what it found so far marked as cut short.
- MCP: pictures read at most 32 MB from cams before scaling, and their ffmpeg runs share the thumbnails' limit of two at a time.
### Security

- An open live-update connection and an open live video now end when their sign-in ends: right away when the person is removed from the account or their viewer token is revoked, otherwise within a minute (an expired session, an address taken off the allow-list).
- Archive videos and thumbnails are no longer kept in the browser cache, like every other camera image.
- The viewer-token sign-in reads at most 4 KiB of a request, also when the browser doesn't say the size up front.
