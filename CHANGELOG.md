# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Added

- "Save clip around this" on the Timeline (#179, phase 3): next to "✧ Check with Vision" (on every second) and in a check's result, it opens the Save dialog anchored at that second: "Save clip around 14:03:22", pre-roll and post-roll 10 s each by default (21 s), up to 5m (2m at 1080p) at every composed size, the post-roll up to the seconds already past, and a "Made of" line (the FTP clip's times and/or "Stills only (1 per second)"). cam-proxy composes it from its FTP clips where they cover a second and its 1 fps stills elsewhere; when nothing is kept there (older than 7 days) the dialog says so and offers no Generate. The file is `<camera>-<YYYY-MM-DD_HH-MM-SS>-around.mp4` in the camera's time. `POST /api/cameras/:id/compositions` takes `{at, preS, postS, size, badge, timeZone?, dryRun?}` instead of `{eventId, …}`, checked by cams first. Needs cam-proxy with compositions around a second (its 409 `nothing_to_compose`; an older one answers 400).

