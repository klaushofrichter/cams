# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Live video: a third quality choice, **Balanced**, between SD and 4K, for cameras that have the Reolink app's *Balanced* stream (the CX820 and the E1 Outdoor Pro; the cam-proxy says so). The quality button becomes SD | Balanced | 4K for such a camera (SD | Balanced where the browser plays no HEVC: Balanced is H.264). The label names Balanced by its picture, e.g. "512p" for the CX820's 896×512. Cameras without it, and cam-proxies that don't report it, keep SD/4K. If Balanced doesn't start within 15 s, that camera plays SD for the rest of the visit. The live-quality preference can be Balanced too (SD on cameras without it).

