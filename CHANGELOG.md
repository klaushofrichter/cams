# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Fixed
- Video page: after leaving the page while the player fills the screen (phones without fullscreen), one Back now returns to the recording at the moment last shown; it used to take an extra Back.
- cams-admin mode: when a cam-proxy refuses cams's admin token because its allow-list doesn't include admin tokens yet, cams tries again after 5 minutes, then 15, 30 and every hour (it used to wait a day or a restart), so the proxy sign-in link and camera renames work soon after the proxy allows it.
- Video page: a camera that was offline (for example after a power cut) returns to live video by itself once it is back: at once when its cam-proxy reports it, otherwise within 30 seconds. It used to need a reload or Retry.
- Video page: the pan/tilt/zoom panel is hidden while the camera shows offline (its moves could only fail then), and comes back with the camera.
- Settings → Assistant access (MCP): a token that couldn't be revoked now says so instead of failing silently.
- `admin-enroll` prompts for the enrollment code ("Enrollment code (input hidden):") instead of waiting silently, and says when it reads the code from piped input.
- MCP: a request body over 64 KiB is refused also when it is sent without a length, and only after the token is checked; malformed JSON gets a JSON error.

