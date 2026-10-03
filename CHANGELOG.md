# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Changed

- An expired session no longer drops you on the start page: cams renews it silently with Google when it can and brings you back to the page you were on; when Google needs you to sign in, the start page's sign-in returns you to that page too. This covers every request the app makes, including images, videos and the event stream.

