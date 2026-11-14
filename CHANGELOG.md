# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Timeline previews, stills and Vision check pictures are no longer kept in the browser's cache: after signing out nothing stays behind, and a picture of another account's camera with the same short name can't be shown by mistake.
- Composed clips on iPhone and iPad: seeking past the end of a composed clip's preview now gets the clip's size back, so Safari can keep playing it.
- Scrubbing a composed clip's preview no longer leaves requests to the cam-proxy running after the browser has moved on.
- Alt-click (download) on the app's own links, such as the menu, "Show in Timeline" and "Open in Video", now does what the browser normally does instead of moving within the app.
- Internal cleanup, no change to what you see: shared helpers replace repeated code across the server and the web app. Opening a day of recordings with new thumbnails does less disk work on the server, and the History view no longer re-asks for its time range on every tab switch.

