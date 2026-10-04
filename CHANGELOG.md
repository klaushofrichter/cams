# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Added

- Still checks on the Timeline (#179): "✧ Check with Vision" under the large still sends that second to Google Vision through cam-proxy and shows the boxes, the object list and what it found in place, with the month's and today's budget beside the button (disabled with the reason when Vision is off, paused or out of budget). Checked seconds are marked ✧ and their minutes with a dotted corner; "✧ Checks (n)" lists the day's checks, ◀ ✧ ▶ and Shift+←/→ step between them, and checks made elsewhere appear live. A check that finds a card's label confirms the card like an automatic analysis. Needs cam-proxy with still checks.

