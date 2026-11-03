# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


- Blank thumbnails now say why. Hovering a hatched frame under the timeline on the Video page, or a missing second on the Timeline page, shows "No still picture available", or the reason when cam-proxy recorded one for that stretch: "Camera was offline (09:39–09:41)", "Camera restarted", "Camera power cycled (PoE)", "Camera address changed", "Proxy was stopped", "Proxy restarted after a crash" or "Proxy storage was full". On a phone, tap the frame (the Video page shows a short note) or the second (Timeline opens the "not available" view, now with the reason). Missing seconds on the Timeline are clickable for this. Needs a cam-proxy with the outages API; with an older one the plain sentence shows.
