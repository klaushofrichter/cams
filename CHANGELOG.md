# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Added
- Proxies are confirmed once per account; cameras moved to a confirmed proxy switch over without a held change. A new or changed proxy shows in the held banner (above the cameras) with a Confirm button.

### Notes
- Going back to an older cams drops the trusted proxies from `trust.json` on its next save; after upgrading again, the one-time setup trusts the proxies your confirmed cameras use once more.
- The proxies of an account whose configuration failed to load at the first start with this version are not trusted automatically: they need one Confirm each.

