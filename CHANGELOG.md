# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Event cards: a card holding several events of one AI type says how many, e.g. "Person 2x" (Vehicle and Pet likewise; Motion never gets a count).
- Event cards: the thumbnail is the still of the card's first event Vision confirmed, else the second its first person, vehicle or pet event was detected (not the highest-scoring analysis); it changes when a Vision result arrives later, and a card that got the start-of-recording image because the detection still wasn't available asks again.
- Save clip: lengths read "1m 43s", "44s", "5m" everywhere in the dialog, and the limit shows only when it matters: for a generated clip (pre-/post-roll or another size) or a recording over 10 minutes ("Result: 1m 43s · at most 5m"), not for a plain save.

