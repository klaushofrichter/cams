# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- MCP server: on by default. `MCP_ENABLED=false` turns it off. Plain http viewers (the Pi, the mini PC) still serve it only with `MCP_ALLOW_HTTP=true`.
- New start page: it now shows what the camera system does. Highlights first (live view, AI-labelled events, a still for every second, clips, the archive, the local gateway), then details on watching, finding, keeping, running a site, the fleet console and the Pi kit, and a closing "Built by Skylar Technology" section. Sign-in works as before, and the page has a light/dark theme switch.

