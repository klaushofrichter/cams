# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Video page: the REC badge says what the player shows: the clip's quality ("REC 07:18:32 AM · SD", or "· 4K" for the main stream) or the stills ("· Still"); screen readers hear it too. The live badges are unchanged.
- Video page: the timeline under the player is darker in dark mode (bar, stills and the hatched parts), and motion-only clips are drawn solid, so every clip mark has at least 3:1 contrast (motion clips were 2.2:1 on the bar, 1.7:1 over stills; now 4.5:1 and 3.3:1). Light mode is unchanged.
