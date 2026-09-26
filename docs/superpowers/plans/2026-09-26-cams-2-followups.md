# Plan 2 follow-ups

Deferred findings from the Plan 2 reviews. None of them blocked the release v2026.09.25.3.
Plan 1's list (`2026-09-25-cams-1-followups.md`) still applies. Some of its items were done in
Plan 2: the CHANGELOG reset, the vendor fullscreen fallback (still open), and the tests.

## Verify on the real camera
- Reboot the camera while Live is open. The picture must come back without a page reload. This is the recovery path fixed after the final review; unit tests cover it against a mock built to match the firmware.
- Leave Live open for 12 minutes or longer. The 9-minute swap should be invisible, and the 600 s cut should never show.
- Check that HD appears in Chrome and Safari on macOS and plays the H.265 main stream.

## Robustness
- If `create-camera-user.sh --reset` fails after AddUser, the camera and the Secret no longer match, and the fix is another `--reset`. The script could roll back, or print exact recovery steps.
- ~~A failed `/status` fetch (app or network down) is shown with the `camera_error` wording ("The camera answered with an error"). It should say that the app, not the camera, failed.~~ (done in Plan 5)
- The semaphore has no acquire timeout. Today every gated call has a 10 s inactivity timeout, so this is safe.
- There is no loop guard for a camera that keeps rejecting fresh tokens. The damage is bounded: at most 2 logins per request.
- An abort during the post-reset `GetDevInfo` re-validation surfaces `camera_offline`. The route handles this quietly, and a single `GetDevInfo` may still be in flight for up to 10 s.
- When the camera ends a stream cleanly, the proxy logs nothing (the player still reconnects). Consider an info-level log line.
- `liveCounts` map entries are never deleted. The registry is fixed, so this is harmless.
- `deploy-production.yml` has no job-level `concurrency:` group.

## Tests
- "resets even with a valid token" doesn't assert that no retry happens. Count `/flv` connects in the mock.
- The e2e tests forward browser console errors on every run, which adds some noise to passing runs.
- The pacing and stream-close unit tests use real time (a 5× margin and a 100 ms wait). Fake timers would make them deterministic.
- The comment in the plain disconnect route test claims coverage of the abort mutation, but that coverage comes from the pre-resolve test.
- There is no component test for `Live.svelte`; e2e covers it.
- `svelte-check` is still unavailable because of TypeScript 7 (see the Plan 1 follow-ups).
- Some e2e specs may hit the 4-stream cap when run with many local workers. CI uses 2 workers.

## UI
- ~~Snapshot errors are silent. The download link saves nothing. Consider fetching the snapshot and showing an error.~~ (done in Plan 5)
- There is no `webkitRequestFullscreen` fallback for older Safari.
- When a standby stream fails and then the active one fails, the standby retry is lost until the next swap. Nothing freezes.
