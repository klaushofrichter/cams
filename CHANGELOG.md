# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- A day's recordings are listed by the proxy with its camera-local `date` parameter (cam-proxy v2026.10.02.4): one camera-local day per query, exact on DST days, and 2 camera Searches at the proxy instead of 4 for a cold day view. An older proxy that answers 400 to `date` is asked again with the old 25-hour window. A proxy whose Search queue is busy (503 `busy`) is asked once more after its Retry-After (at most 5 s) before the camera's own Search takes over. The e2e's cam-proxy image is v2026.10.02.4.
- When a camera's cam-proxy fails and cams falls back to the camera's own Search, the day and month lists are kept for 30 seconds only, so they follow the proxy again soon after it recovers. A proxy that is down or hanging is tried once, not once per list, for 15 seconds. A recording cut by the proxy mid-download is logged.
