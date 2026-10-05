# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Added

- **Archive**: keep a clip on the camera's cam-proxy apart from its normal retention. The Save dialog has an **Archive** button next to Save (plain SD and 4K saves, composed clips, "around this second"): a name (default date, time and camera), a retention (365 days or forever) and labels (Pet, Person, Vehicle, SD, 4K, preselected from the clip, plus your own), with progress and readable errors (too little space says the sizes), then "Open in Archive".
- **Archive page** (menu "Archive"): every cam-proxy's archived clips in one list with thumbnails; sort by any column; filter by labels, camera and text; select one, a shift-click range or all; delete (confirmed), download a ZIP (clip, metadata and thumbnail), set labels or retention on many, edit one. A player with ±1/±10 s, a seek bar and the clip's events and Vision findings. The recorded time opens the Video page while the camera still has the recording. Updates live; cards on a phone.

