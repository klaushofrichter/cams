# Request for the Cluster session: camera passwords out of the cluster

For Klaus and the Cluster session (kube-setup). cams code does not change
kube-setup; this note is the request.

## Why

From the release with "cams through the proxy" (cams plan
`docs/superpowers/plans/2026-10-31-cams-through-proxy.md`, cam-proxy spec
`docs/superpowers/specs/2026-10-30-camera-onboarding-design.md` §6, §8), a
camera whose cam-proxy lists `camera-calls` is reached only through that
proxy. cams holds no password for it and never calls it directly. The
cluster's cams reads camera passwords from the `cams-cameras`
Secret `cams-cameras` (key `cameras.json`, mounted read-only at `/etc/cams`; checked with the Cluster session 2026-10-31 — there is no separate credentials Secret); cams can't remove
entries there, so it logs `camera_password_left {cameraId, reason:
"read_only"}` once per such camera instead.

## Before the release: where cams keeps the per-proxy switch

Checked 2026-10-31 (Cluster session): the cams ksvc sets `PREFS_FILE=/var/lib/cams/preferences.json` on the PVC `cams-data` (writable, Retain), so `proxy-features.json` lands at `/var/lib/cams/proxy-features.json`. Nothing to change.


cams keeps which proxies take camera calls in `proxy-features.json` (no
URLs, no tokens). It lives next to `PREFS_FILE` (the cams-data volume), or
at `PROXY_FEATURES_FILE`. There is no temp-folder fallback: a cams with
cameras that have a cam-proxy refuses to start when neither is set. Check that
`manifests/cams/` sets `PREFS_FILE` on the persistent volume (or add
`PROXY_FEATURES_FILE` there).

## Step 1: remove the proxied cameras' entries

After the cams release is deployed **and** the cluster's cam-proxies run the
release with `camera-calls`:

1. Check: `GET /api/cameras` (signed in to cams) shows `"throughProxy": true`
   for each camera, and Live plays for each (the live request answers
   `video/mp4`). cams's log has `camera_password_left` for exactly these
   cameras (`kubectl logs` of the cams pod, `msg` = `camera_password_left`).
2. Remove those cameras' passwords from the `cams-cameras` Secret's
   `cameras.json` (Klaus approves any change to a cams Secret). List the key names only, never the
   values (go-template over `.data`).
3. Restart cams (or let the next deploy do it); `camera_password_left` no
   longer appears.

## Step 2: retire the Secret

Once no camera of the cluster's cams is reached directly (every camera has a
proxy with `camera-calls`, `GET /api/cameras` shows `throughProxy: true` for
all), retire the `cams-cameras` Secret and the
`CAMERA_CREDENTIALS_FILE` env and mount from `manifests/cams/`.

A camera without a proxy (or with an older one) still needs its password
there: keep the Secret until there is none.

## Rollback

If a cam-proxy is rolled back to a release without `camera-calls`, its
cameras go back to direct calls and need their passwords again: they show
"cams has no password for this camera yet" until the Secret has them back.
