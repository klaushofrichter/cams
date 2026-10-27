# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- MCP server at `/mcp`: an AI assistant (Claude Code, Claude Desktop) can read one account's cameras with a personal token made on Settings → "Assistant access (MCP)": cameras, current pictures, events with AI labels, recordings, the archive, short clips as 15-minute links, and the Vision budget. Every member makes their own tokens; admins see and revoke all of the account's. Off unless `MCP_ENABLED=true`.
