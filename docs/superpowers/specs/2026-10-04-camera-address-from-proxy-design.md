# Camera address from cam-proxy (Pi demo kit)

2026-10-04. Klaus approved the Pi demo kit's configuration ("Yes to both"):
on the Pi, one file (`/srv/cam-proxy/.env`) holds the camera's address
(`CAMERA_HOST`), the Pi's (`PI_ADDRESS`) and the login token, next to
cam-proxy's secrets. cams no longer carries the camera's address on the Pi: it
takes it from cam-proxy, which knows it (cam-proxy spec
2026-10-04-pi-config-design). On the road only that one file changes, and
cam-proxy's "Find camera" writes the camera's line itself.

## 1. The cameras file

- A camera entry may say `"host": "from-proxy"` when it has a `proxy`; cams
  then uses the address cam-proxy reports. Without a `proxy` that value is
  refused at startup (`camera registry entry 0: host "from-proxy" needs a proxy`).
- **Ruling: the explicit `"host": "from-proxy"`, not an omitted `host`** —
  why: a `host` forgotten in the cluster's `cams-cameras` Secret keeps failing
  at startup as today instead of silently waiting for a proxy; the marker
  also reads as what it is in the Pi's file — cost if wrong: accepting an
  omitted `host` later is one line and a doc change.
- The cluster config (explicit hosts) is unchanged and behaves as before.

## 2. Where the address comes from

- cam-proxy's `GET /api/cameras` entries carry `address` (the camera's
  `camera.host`: host and optional port, no secret). cams reads it whenever the
  proxy's stream comes up (the same read that takes the camera's name, #169),
  and from the `camera` stream message, which now carries `address`
  (`{cam, name, address}`; a message may carry only `address`).
- The address is checked like a host (`^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$`,
  port 1–65535); anything else is ignored (logged at debug).
- **Ruling: the last address stays while the proxy is down or switched off**
  — why: unlike the name (shown text, which falls back to the registry name),
  the address is what the direct camera features need most exactly when the
  proxy is away (the fallback for status, snapshot, live); the camera keeps
  its address while the proxy restarts — cost if wrong: after a move, the
  direct features try the old address until the proxy is back; that is the
  state before this change anyway. It lives in memory only: after a cams
  restart it is unknown until the proxy answers.
- A changed address drops the camera's direct client (its login token belongs
  to the old address), so the next request logs in at the new one.

## 3. Until the address is known

- The direct camera client answers every request with the new error code
  `camera_address_unknown` (503, like `camera_offline`), without touching the
  network.
- The UI says "Waiting for the proxy to report the camera's address." (the
  camera card's and Live's offline reason; the Settings page's load error).
- The camera's web UI link is left out until the address is known.
- **Ruling: a new error code instead of `camera_offline`** — why: "the camera
  could not be reached" would send a person to check the camera, while the
  thing to check is the proxy; the code is new for clients, but every place
  that maps codes falls back to a generic text — cost if wrong: one more code
  in `offlineReason`; mapping it back to `camera_offline` is trivial.

## 4. Compose and docs

`deploy/pi/compose.cams.yaml`: `env_file: ../.env` (cam-proxy's one file in
`/srv/cam-proxy/.env`); `COOKIE_SECRET` and `CAMS_LOGIN_TOKEN` come from it, so
the `${…:?}` interpolations go.

- **Ruling: `COOKIE_SECRET` moves into the one file too, and cams' own
  `$CAMS/.env` is no longer needed (only `CAMS_TAG`, if a release is pinned)**
  — why: "one file" for every secret on the Pi; compose's `${…}` interpolation
  reads `$CAMS/.env`, not an `env_file`, so leaving the secrets there would
  need two files kept in step — cost if wrong: cams' container sees
  cam-proxy's secrets in its environment (the same Pi, the same owner; cams
  never reads them); moving cams to its own file again is a compose edit.
- `deploy/pi/cameras.example.json`: `"host": "from-proxy"`.
- docs/pi-demo.md: the single `.env` (example without values), the compose
  change, "On the road": Find camera → Use this address → "Point the camera's
  FTP here" in cam-proxy, `PI_ADDRESS` for a new Pi address; nothing to change
  in cams.

## Tests

- Registry: `"from-proxy"` with and without a proxy; other values unchanged.
- Address store: set from `/api/cameras` on stream up, from the `camera`
  message (with and without a name), invalid values ignored, kept while the
  proxy is down, a change drops the direct client.
- Direct client: `camera_address_unknown` without touching the network; the
  status route's offline answer; the web UI link.
- The fake proxy (`test/proxy/fakeProxy.ts`) serves `address`.
- Web: `offlineReason('camera_address_unknown')`, the Settings load error.
