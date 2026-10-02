# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Recordings of a camera with a cam-proxy come from the proxy's recordings API: the SD card's files, fetched over Baichuan, which works while the camera refuses HTTP downloads. Any recording of the last 7 days plays and downloads in SD or 4K again; the proxy's FTP copies and then the camera's own download are the fallbacks. 4K never falls back to the FTP copy (it is SD): when the full-resolution file can't be served, the Save dialog says so and offers the standard quality. The calendar and the day's list come from the proxy too, while it answers; cams searches such a camera itself only on a fallback, and to find a file's folder. The line under the player says "cam-proxy (SD card)" or "cam-proxy (FTP copies)".
