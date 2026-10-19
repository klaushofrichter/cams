# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]


### Fixed

- cams reports its status to cams-admin at least every 10 minutes, also when nothing changed. cams-admin keeps the reports in memory only, so after a cams-admin restart it showed the instance with mode "—" and no shadow differences until cams itself restarted.
