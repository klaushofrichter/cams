# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- **Vision dialog: "Open in History":** next to "Open in Timeline", it opens History at the analysed still's second, paused.
- **Vision percentages:** the dialog lists each finding as "Person - 61% Confidence", and the labels next to the boxes read "Person 84%" or "Ceiling fan 90%".
- **Tag order:** a card lists Motion first, then Person, Vehicle, Pet, Scheduled, then the Vision badges, in History's list, Live's recent events, the line under the video, the Timeline and the Save dialog.
- **Vision badges are buttons of their own:** beside the card's button rather than in it, for screen readers and the keyboard (Tab goes card, badges, download); they look the same. A "not confirmed" badge opens the still of the analysis that covered that kind, and focus stays in the dialog while it is open.

