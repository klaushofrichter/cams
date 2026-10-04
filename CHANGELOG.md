# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Player (History and Live): one-second steps beside the 10-second ones, in the order ⏮ << < ▶ > >> ⏭; the 10-second buttons no longer say "10". Shift+← and Shift+→ step one second (← → still step 10 s). A step on a paused clip shows that frame. Forward steps stay off while Live is at now.
- History: the page heading says "History" instead of "Recordings", as in the menu.
- Live: the History event filter (All / Person / Vehicle / Pet / Motion) sits above the most recent events, which are then the five newest that match. The filter is one saved preference for both panels: a change on Live shows on History and the other way round, and it is kept across page switches, reloads and devices.
- History and Live on a desktop: only the event list (with its hour titles) scrolls in the right-hand panel; the Live / History tabs, "Collapse hours" and the filter chips stay at the top, and the page doesn't scroll with it. The phone layout is unchanged.

