# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- **More from cam-proxy** for a camera that has one:
  - recordings and sub-quality downloads come from the proxy's clips first (the camera only when the proxy has none);
  - event thumbnails are the proxy's stills (fast, no clip download);
  - moving over the Recordings timeline previews the frame of that moment;
  - Live shows the proxy's stills, updated every second, while the video isn't playing, clearly marked: a STILLS badge with the still's time and age, and STILLS instead of LIVE in the header.
