# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Video: the address also holds the timeline's interval (24 h down to 1 min), so a link or a reload opens with the same interval. A link's interval is shown without changing your saved "Timeline zoom"; picking another interval updates the address (without an extra step for Back) and is saved as before.
- Menu: Video now comes back to where you left the Video page in this browser tab: the camera, the day and moment, the interval, and playing, paused or live (before, it always opened live). Back and Forward still step through the pages as before.
- Top bar: the cams logo opens Video live and playing, on the camera you have picked, with the interval kept; the menu's Video is live from then on too. On a phone the logo now shows next to the menu button (it was hidden there).
