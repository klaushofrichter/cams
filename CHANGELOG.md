# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Save clip: a plain save (SD or 4K as recorded) is up to 600 s (a 114 s clip was refused at "At most 1:00"); a generated clip (pre-/post-roll, another size) up to 300 s, 120 s at 1080p. One module (`server/clipLimits.ts`) holds the limits and the length rule for the dialog and the server; the server checks a composition before asking the cam-proxy, and the download answers 400 `too_long` past 600 s.
- Fixed: pre-roll -100 and post-roll 30 on a 114 s clip showed "Result: 0:44" but Generate answered "At most 60 s.". The cam-proxy applied the rolls to its own FTP copy of the recording, which can start earlier or run longer; cams now sends the recording's span with the request (needs cam-proxy with `span` support, cam-proxy PR #140).
- Save clip: pre- and post-roll have sliders next to their fields (kept in step); their ranges never allow a result past the limit or less than 1 s of the clip. A clip longer than a plain save opens with the post-roll cutting it to 300 s at its end, with a line saying so.
- Save clip: lengths in seconds everywhere in the dialog ("44 s"; from a minute on "114 s (1:54)"), in the header, the result, the limit and the errors.

