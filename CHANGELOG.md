# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- A camera in the cameras file may say `"host": "from-proxy"` (with a `proxy`): cams then reaches it at the address its cam-proxy reports (`address` in cam-proxy's camera list, read when the proxy's stream comes up, and in its `camera` stream message). Until then the camera's direct features (status, snapshot, settings) say "Waiting for the proxy to report the camera's address." (error `camera_address_unknown`, 503). The last address stays while the proxy is away. Explicit hosts (the cluster) are unchanged.
- `"host": "from-proxy"` needs `protocol` `https` and a `tlsServername` (refused at startup otherwise): the camera's certificate is checked, so a wrong address from the proxy can't receive the camera login.
- The Pi demo kit uses one settings file, cam-proxy's `/srv/cam-proxy/config/.env`; `$CAMS/.env` is a symlink to it that compose reads only for its `${…}`. `deploy/pi/compose.cams.yaml` has no `env_file`: the container gets `CAMS_LOGIN_TOKEN`, `COOKIE_SECRET` and `CAMS_TOKEN_USER` only, never cam-proxy's secrets. `cameras.example.json` says `"host": "from-proxy"`. docs/pi-demo.md: the one file, and on the road only cam-proxy's Find camera and `PI_ADDRESS`.

