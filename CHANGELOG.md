# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- cams can take its accounts, users and cameras from cams-admin (`CONFIG_SOURCE=cams-admin`; `file` stays the default and the way back). One cams serves several accounts, and nothing crosses between them. Without cams-admin it keeps working from its last configuration. (The account picker and the admin banners follow in the next release.)

