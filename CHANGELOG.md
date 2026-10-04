# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Video page: the REC badge says what the player shows: the clip's quality ("REC 07:18:32 AM · SD", or "· 4K" for the main stream) or the stills ("· Still"); screen readers hear it too. The live badges are unchanged.
- Video page: the timeline under the player is darker in dark mode (bar, stills and the hatched parts), and motion-only clips are drawn solid, so every clip mark has at least 3:1 contrast (motion clips were 2.2:1 on the bar, 1.7:1 over stills; now 4.5:1 and 3.3:1). Light mode is unchanged.
- Video page: the popup over the timeline names what is under the pointer: an icon per event type of the clip (person, vehicle, pet, motion, in that order; "2x" where a type has several events) or "Still" over the stills, each with its name for screen readers and as a tooltip. The popup has one size for clips and stills, so it no longer jumps along the bar.
- Video page: with the pointer resting on the timeline while time moves under it (playback, live), the popup follows: its time at once, its types and picture too (a new picture at most once a second). It stops when the pointer leaves the bar or the tab is hidden.
- Video page: Fullscreen works for live only, so in a recording it is off like Quality and Light (still focusable, "Only in live mode", and a click or tap shows "Quality, light and fullscreen work only in live mode.").
