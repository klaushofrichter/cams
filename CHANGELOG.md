# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- cams can take its accounts, users and cameras from cams-admin (`CONFIG_SOURCE=cams-admin`; `file` stays the default and the way back). One cams serves several accounts, and nothing crosses between them. Without cams-admin it keeps working from its last configuration.
- A person in several accounts picks one after signing in, and can switch in the menu.
- Viewers can watch, browse recordings, download and save clips; changing cameras, the proxy switch and the archive is for account admins.
- When cams-admin changes where cams connects to a camera or proxy, cams keeps the old connection until an account admin confirms (a banner shows old and new).
- Admins see when the configuration hasn't been refreshed for a day, or when cams-admin no longer accepts this cams.

