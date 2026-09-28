# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- History strip: after now and before the oldest content is striped.
- Lists are newest first (hour groups and events).
- One History panel: Events is merged into it (old `panel=events` links open History).
- Downloads show a thumbnail per recording.
- Settings: the cam-proxy card links to the camera's cam-proxy web page while
  it answers (the proxy reports its address; cam-proxy v2026.09.28.2).
- Default camera: "Last camera used" (remembered on every switch) replaces
  "First camera".
- Live events (Settings, on by default): a new event shows at once at the top
  of the History list and on the strip ("recording…" until the camera lists
  it), and a notification in the top bar ("Person on Den", 1 s, then fading)
  for the types chosen in Settings.

