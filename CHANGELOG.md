# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Event cards with a person, vehicle or pet show the moment it was detected as their thumbnail: the still Vision analysed and confirmed, or the cam-proxy's still at the second the camera's AI flagged it, instead of the still 2 s into the recording, which was usually the empty pre-record (#157). Motion-only cards, and cards without such a still (a gap, stills off, older events), keep today's thumbnail.
