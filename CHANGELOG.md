# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Live quality: where the browser can't play H.265 (the Pi's Chromium, for example), 4K stays visible but dimmed, and its tooltip says why. It used to disappear, which looked as if the camera had no 4K. Cameras without a third stream show SD and a dimmed 4K there instead of no control.
- The landing page's animations run only while their section is on screen, and pause after 30 s without input until the next pointer, key, scroll or touch. The moving hero tags have a nearly solid background instead of a blur. An open landing page uses far less CPU on small hardware such as a Raspberry Pi (#327).
- A local viewer (token login, no Google) opens the sign-in page at `/` instead of the landing page (#327).
- The contract drift check no longer fails when only its cleanup of temporary files fails (#327).

