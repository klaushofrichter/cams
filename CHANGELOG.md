# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- **Timeline fixes:** clicking an open minute's tile closes it; "No still for that second." and "Could not load that still." show next to the seconds instead of at the top of the page; Vision's boxes show when the page opens at any time inside an analysed still, and appear on an open still when its analysis arrives; box labels at the picture's top or right edge stay inside it; "keeps no stills" shows only when the cam-proxy says so.
- **Save dialog fixes:** when cams can't ask the cam-proxy whether it has a copy of the clip, pre-/post-roll stay offered; a composition lost while the page was in the background is always called that; a result kept open stays available past 20 minutes.
- **Vision after a cam-proxy upgrade:** cams asks for Vision results again whenever the proxy's stream reconnects, so badges appear without restarting cams; while the proxy fails, a day's badges stay as they were.
- **Vision dialog: "Open in History":** next to "Open in Timeline", it opens History at the analysed still's second, paused (also when History was playing). History now also pauses when it moves to a time from outside the player (a link, Back/Forward, or a restored position).
- **Vision percentages:** the dialog lists each finding as "Person - 61% Confidence", the labels next to the boxes read "Person 84%" or "Ceiling fan 90%", and a badge's tooltip reads "Vision: Person 78% · medium confidence".
- **Tag order:** a card lists Motion first, then Person, Vehicle, Pet, Scheduled, then the Vision badges, in History's list, Live's recent events, the line under the video, the Timeline and the Save dialog.
- **Vision badges are buttons of their own:** beside the card's button rather than in it, for screen readers and the keyboard (Tab goes card, badges, download); they look the same. A "not confirmed" badge opens the still of the analysis that covered that kind, and focus stays in the dialog while it is open.

