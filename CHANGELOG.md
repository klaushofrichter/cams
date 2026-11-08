# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- A proxy token that cams-admin refused to register (for example `token_proxy_ahead`) is now tried again every 1, 2, 5, then 10 minutes until it succeeds, instead of waiting for the next configuration change or a day.
