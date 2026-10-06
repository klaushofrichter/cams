# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Added
- A cam-proxy with a site CA is pinned by its CA fingerprint (`caFingerprint`): cams reaches it over HTTPS and verifies its cameras against that CA, or against the camera's own certificate when the proxy reports it couldn't install one.

