# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Cameras behind an up-to-date cam-proxy are reached only through it: live video, status, settings, light, reboot and the camera login go through the proxy, and cams keeps no camera password for them. When such a camera is offline because of its password or its certificate, admins can enter the password or trust the certificate (the one the proxy measured) right from the offline box.

