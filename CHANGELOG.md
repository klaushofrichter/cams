# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Fixed

- E1 Outdoor Pro: an event whose only copy on the proxy is the camera's FTP clip, which starts about 8 s after the SD recording, is now found. Such an event can be composed again and can use the FTP clip for playback, saving and archiving when the SD file can't be reached. The FTP clip lacks the event's first seconds: in a composed clip, those seconds and any pre-roll show stills, or a "No recording" card where there is no still.

