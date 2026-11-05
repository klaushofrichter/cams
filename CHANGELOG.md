# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


### Added

- Video: double tap the picture (double click on a computer) to go fullscreen. In fullscreen, a double tap in the middle of the picture (a double click anywhere) leaves it again. A single tap in the middle still plays or pauses, a moment later so a double tap doesn't also play or pause; the sides still step 10 s on every tap. While zoomed in, a double tap still goes back to normal size.
- Video: links to a moment. The address now holds the time to the second and whether it was playing, so a reload comes back to the same moment, playing or paused, and a copied address opens there for anyone else (paused, unless it was copied while playing). Older links still work.
- Video: the hour title in the event list is tinted too while the playing moment is inside one of its events, so a collapsed hour shows where you are.
- Video: the address also holds the timeline's interval (24 h down to 1 min), so a link or a reload opens with the same interval. A link's interval is shown without changing your saved "Timeline zoom"; picking another interval updates the address (without an extra step for Back) and is saved as before.

### Changed

- Menu: Video now comes back to where you left the Video page in this browser tab: the camera, the day and moment, the interval, and playing, paused or live (before, it always opened live). Back and Forward still step through the pages as before.
- Top bar: the cams logo opens Video live and playing, on the camera you have picked, with the interval kept; the menu's Video is live from then on too. On a phone the logo now shows next to the menu button (it was hidden there).
- Video: a zoomed picture stays zoomed when playback runs into the next recording, when stills stand in for the video, and when stepping or dragging the timeline. Picking a moment (a thumbnail under the timeline, an event, another day or camera, back to live) starts at normal size again.
