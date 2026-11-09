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
- A clip being made can be cancelled only by the person who started it or an account admin; everyone in the account can still follow it and download the result.
- One person can keep at most 6 live-update connections open (tabs and devices), so they can't use up the 20 the server allows.
- A malformed answer from a cam-proxy (stills, previews, a started clip) now shows as "proxy unavailable" instead of a server error, and a started clip is no longer lost then.
- A clip request with a missing or wrong setting is refused with a clear reason before anything is asked of the cam-proxy.
### Added

- Settings says when a camera's cam-proxy doesn't allow cams's admin token yet; cams keeps asking on its own.
- The new-proxy banner has Ignore next to Confirm: the proxy stays untrusted (no camera moves to it) and that offer isn't shown again.

### Fixed

- A PTZ position missing on the camera keeps its note under its name, so the list still shows five rows.
- A proxy whose id isn't in cams-admin's usual form can be confirmed from the banner.
