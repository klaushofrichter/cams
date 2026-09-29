# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Live panel: the simulator's version, since when a camera is offline, the
  cam-proxy state even without a link, "Paused while the tab is hidden".
- The strip: 4 px between the small frames; "Back/Forward 30 min" at the
  30-minute zoom.
- Downloads dialog: plays on iPhone (byte ranges), focus stays in the dialog,
  file names in the camera's time, says when the proxy has no copy, keeps a
  finished result, recovers after the phone switched apps.
- History: filter chips no longer add browser history entries; no source
  note when a day failed to load.
- Timeline: events of the neighbouring days are marked (another time zone);
  "keeps no stills" instead of "not reachable" when the proxy keeps none.
- cam-proxy links: Ctrl/⌘-click opens a background tab; a blocked popup no
  longer navigates cams away; proxy addresses with a path work.
- Fewer proxy requests: one lookup per clip, at most three proxied thumbnails
  at a time, one GetTime for a burst of events; stream info retried after 30 s.
- Shutdown ends the live-event relays at once.

