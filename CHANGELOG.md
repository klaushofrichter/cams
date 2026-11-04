# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- **Assistant (MCP): fleet tools for account admins.** `list_proxies`, `list_viewers` and `list_moves` show an assistant this account's proxies with their state and problems, the viewers serving it with held changes, and its camera moves. Read-only, this account only, not for viewer-role tokens. They need the matching cams-admin release, and say so until then.

