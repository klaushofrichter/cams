# Plan: camera address from cam-proxy (Pi demo kit)

Spec: `docs/superpowers/specs/2026-10-04-camera-address-from-proxy-design.md`.
TDD.

1. Tests first (`test/cameraAddress.test.ts`): the registry's `"from-proxy"`,
   the address store, the direct client's `camera_address_unknown`, the
   address from the fake proxy (stream up, `camera` message, kept while away).
2. The fake proxy serves `address` in `/api/cameras`.
3. `cameraRegistry.ts` (`FROM_PROXY`, `cameraHost`, `setReportedAddress`,
   `addressEvents`, the web UI link), `reolink/clients.ts` (client per
   address), `reolink/client.ts` (the new code), `proxy/names.ts` (reads it).
4. Web: `offlineReason`, the Settings load error.
5. `deploy/pi/compose.cams.yaml` (`env_file: ../.env`),
   `cameras.example.json`, docs/pi-demo.md, README, CHANGELOG.
6. `npm test`, `npm run build`, `npm run check`, `npm run lint:types`; PR; CI
   (e2e runs there).
