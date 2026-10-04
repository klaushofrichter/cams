# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- cams runs on the cam-proxy Raspberry Pi as a self-contained demo kit (docs/pi-demo.md): the image is built for arm64 as well as amd64.
- Token sign-in: with `CAMS_LOGIN_TOKEN` set, the start page offers "Sign in with token" (below "Sign in with Google", or alone when Google isn't configured). Google sign-in is now optional.
- `COOKIE_SECURE=false` lets the session cookie work over plain http on the LAN; the cluster keeps Secure cookies.
