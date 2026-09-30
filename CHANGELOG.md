# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- **Vision on the cards:** with cam-proxy's Google Vision analytics (cam-proxy v2026.10 or later), event cards in History and Live show Vision's confidence next to the camera's label ("✦ Vision 84%"), "not confirmed" when Vision found none, or an extra finding ("+ Pet 70%"). New analyses arrive live.
- **Timeline on cam-proxy's model:** a minute opens its seconds under its hour, a second opens the large still with Vision's boxes ("Show all objects"), and "Open in History" opens History paused at that second. The top viewer, "Show in timeline grid" and the red frame are gone.
