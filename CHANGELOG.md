# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- MCP server: on by default. `MCP_ENABLED=false` turns it off. Plain http viewers (the Pi, the mini PC) still serve it only with `MCP_ALLOW_HTTP=true`.
- New start page that shows what the camera system does: highlights first, each linking to the section that explains it (watching, finding, keeping clips, the Reolink cameras, the proxy, hardware from a Raspberry Pi to many cameras, the cams-admin console, and open source with the MCP server and llms.txt), with screenshots of the app, the proxy's admin UI and the cams-admin dashboard, the Pi's e-paper display cycling its four pages, numbers, and a closing "Built by Skylar Technology" section. Subtle scroll reveals and hover effects, all off with reduced motion.
- Two sign-ins in the header's upper right (behind one "Sign in" button on phones): "Admin console" (cams-admin) and "Cams app". Where Google sign-in is configured, Cams app goes straight to Google; on the Pi and mini-PC viewers it opens the new sign-in page, /signin, which holds the token form, and a token form post now comes back there (/signin?login=failed or unavailable). The start page shows no sign-in form any more. A light/dark switch is on the start page too.
- A "DEMO · simulated footage" sash across the start page's top right corner, like the games site's: a label, not a link.
