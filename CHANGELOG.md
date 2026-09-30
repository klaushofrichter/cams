# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Live panel: the light button is one colour, a bulb with rays when the light is on; after a click it waits for the new state (2 s at most), so a double click doesn't switch the light back.
- Live panel: the cam-proxy line reads "cam-proxy: connected", with "connected" as the link to its page, or "cam-proxy: not available".
