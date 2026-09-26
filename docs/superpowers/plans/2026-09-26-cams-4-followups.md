# Plan 4 follow-ups

These were found while Plan 4 was built and reviewed, and deliberately left open.

## To check on real hardware
- **iPhone Safari and keep-alive.** WebKit may pause a hidden, autoplay-muted video, or suspend the whole page. If it does:
  - coming back to Live reconnects instead of showing the picture at once;
  - a suspended page never fires the keep-alive timer, so its socket can hold one of the 4 live slots until TCP gives up.

  A server-side stall timeout would cover the second case: destroy a stream that hasn't drained for about 30 s.
- **Reboot "sent but unconfirmed".** Check what the real camera does on Reboot. Does it reply before going down, or does it drop the connection?

## Known and accepted
- **Reboot on a stale kept-alive connection.** If the camera closes an idle kept-alive connection just as the Reboot is written, the app reports 202 "sent, unconfirmed" and starts the 120 s cooldown, although nothing rebooted. It never causes an extra reboot. Fix: give the reboot a fresh connection, or treat ECONNRESET on `req.reusedSocket` as "not sent".
- **Preferences during a rollout.** Two pods can save at the same moment during a rollout (a window of a few seconds), and one update is then lost.
- **OSD name check.** `\p{C}` includes unassigned code points, which depend on the engine's Unicode version. A brand-new character could pass in the browser and fail on the server, giving a 400. The user's edits are kept.
- **Empty `osdTime`.** A camera reply without `osdTime` would send `osdTime: {}`. The real camera always reports it.
- **Favicon frame.** Only the SVG favicon gets the frame; browsers that use the PNG show none. The `app.html` `<title>` differs from the idle title.
- **Camera web UI link.** `webUiUrlOf` with an unbracketed IPv6 address, or an unclosed bracket, gives a bad URL. The registry doesn't validate `host`.
- **Certificate check and the API gate.** `cameraCertificate()` runs outside the API gate: one short TLS handshake per Device or About load, with a deadline.
- **Mock camera.** `GetAiAlarm` falls back to "people" for an unknown type.
- **Cosmetic:**
  - the clock uses the locale's numbering system (not forced to Latin digits);
  - dead `.compact .ticks` CSS;
  - the now marker's label.
- **Group state is lost when switching panels.** Hour-group open/closed state resets when switching between Events and Downloads.
- **Missing final fetch at midnight.** Recordings doesn't fetch one last time at midnight, so clips from the final minute of a day show only after you revisit that day.
- **Test-only accessors in production code:** `PriorityGate.queued` and `RecordingsService.transferQueueLength`.
- **M4 e2e timing.** The M4 e2e check ("edits kept after a 400") uses a fixed 300 ms wait.

## Rulings made during execution (from the SDD ledger)
- Ruling R1: T3 updates any existing assertion of the exact /api/cameras body to include webUiUrl — a spec-driven change — cost: none.
- Ruling R2: e2e preference changes from T7 (timelineZoom) and T12 (liveKeepAlive) each PUT only their own field. The server serializes file writes and merges, so the tests don't clobber each other. Each restores its value. Tests that change preferences run desktop-only — cost if wrong: flaky e2e, caught by two green runs.
- Ruling R5: T13 task review folded into the final whole-branch review (small store + wiring, e2e-covered) — cost: a fix wave if needed.
