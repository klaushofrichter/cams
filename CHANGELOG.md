# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


- Recordings workspace: day timeline (24 h / 6 h / 1 h zoom), event list with thumbnails and trigger filters, clip player with ±10 s and previous/next, SD and full-quality downloads. History, Events and Downloads share one time cursor, kept in the URL.
- Live page shows today's recordings on a mini timeline; clicking opens the clip.
- Fullscreen on phones uses the video's own player.
- Clip media has its own rate limit; thumbnails are made by ffmpeg in the pod with a bounded disk cache.
