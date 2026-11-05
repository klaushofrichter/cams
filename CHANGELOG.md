# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Sign in with a token: a token made in cams-admin lets someone watch the cameras of its accounts without a Google account, until it expires. The sign-in page has "Sign in with a token": paste the token, scan its QR code with the phone's or laptop's camera, or open its link, which asks "Sign in as '<name>'?" before signing in. Revoking the token in cams-admin, or making it shorter, signs its sessions out within about a minute; a viewer that hasn't reached cams-admin for 24 hours stops taking these tokens. The Pi's own sign-in token keeps working as before.
- About shows who is signed in: the Google address, or the token's name and how long it is valid.

