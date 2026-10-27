# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- MCP server: on by default. `MCP_ENABLED=false` turns it off. Plain http viewers (the Pi, the mini PC) still serve it only with `MCP_ALLOW_HTTP=true`.
- New start page that shows what the camera system does: highlights first, each linking to the section that explains it (watching, finding, keeping clips, the Reolink cameras, the proxy, hardware from a Raspberry Pi to many cameras, the cams-admin console, and open source), with screenshots of the app, the proxy's admin UI and the Pi's e-paper display, numbers, and a closing "Built by Skylar Technology" section. Subtle scroll reveals and hover effects, all off with reduced motion.
- The sign-in moved to the upper right of the header (behind a "Sign in" button on phones), next to a link to the admin console. A light/dark switch is on the start page too.
