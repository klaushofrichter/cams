# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Video page: in fullscreen the `● LIVE` badge shows again (the whole player goes fullscreen now, not only the live picture), and it stays fullscreen when you step back into a recording or go live again.
- Video page: fullscreen for recordings and stills (#182), with controls over the picture that hide after 3 s and come back on a mouse move, a tap or a key: previous/next event (skipping the events the filter hides), 10 s and 1 s back and forward, play/pause, back to live and leave fullscreen. Keys: ← → 10 s, Shift+← → 1 s, [ ] or PgUp/PgDn previous/next event, Space play/pause, Esc leave. On a phone: swipe left/right 1 s forward/back, tap the left/right third 10 s back/forward, tap the middle play/pause; a short hint confirms each step. The Fullscreen button is no longer "only in live mode".
- Video page: on an iPhone (and wherever the browser has no element fullscreen) Fullscreen fills the screen with the player instead, live too; Esc, the leave button or Back return. Added to the home screen, cams shows it without any browser bars.

