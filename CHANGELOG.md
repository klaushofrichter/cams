# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- **Camera name, from the camera:** the camera picker, page titles, cards, Settings and the tab title show the name the camera reports: through its cam-proxy (its camera info `name`, and the proxy's `camera` stream message on every change, so a rename in the Reolink app or on the camera shows at once, no reload), or read from the camera itself for a camera without a proxy. The registry name (`cams-cameras`) is shown until the camera has answered and while its proxy is unreachable. The camera id (`cam1`) never changes.
- **Rename in Settings:** a new "Camera name" card. Every signed-in user may rename a camera. The field checks the camera's rules as you type (1–31 characters; letters A–Z, digits, space and `- ( ) + = [ ] { }`; no space at the start or end) and says why a name isn't taken. Save goes through the camera's cam-proxy (`PUT /control/camera/name` with its admin token) or, for a camera without one, to the camera (`SetDevName`, then re-read); the name read back is shown everywhere, a refusal under the field, and "Camera offline" when the camera can't be reached. The on-screen text is the same name on the camera, so its separate name field under "Image and lights" is gone ("Show camera name" stays).

