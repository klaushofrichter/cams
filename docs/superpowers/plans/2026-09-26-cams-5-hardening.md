# cams Plan 5: Hardening and polish

> **For agentic workers:** executed inline (superpowers:executing-plans) by the controller, with one final whole-branch review. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Handle a camera that refuses recording downloads (the camera's state since 2026-09-26) clearly and without hammering it. Close the auth and security follow-ups from Plan 1, and fix three small UI gaps.

**Architecture:**
- **Server:** `RecordingsService` gets a per-camera download-health breaker. After 3 refused clip fetches in a row, clip, thumbnail and download requests answer `503 {"error":"recordings_unavailable"}` at once, without touching the camera. One probe per `RECORDINGS_PROBE_MS` (default 60 s) is let through. A success closes the breaker.
- **Events response:** it carries `downloads: 'ok' | 'unavailable'`, which Recordings shows as a banner.
- **Everything else:** small, local changes.

**Tech Stack:** unchanged.

**Spec:** `docs/superpowers/specs/2026-09-25-cams-design.md` §4 (auth), §6 (errors). Items come from the Plan 1 to Plan 4 follow-up files.

## Global Constraints

- Plans 1–4 constraints apply.
- New error code: `recordings_unavailable`, HTTP 503. Camera-side refusal is detected as `CameraError('camera_offline')` from `download()` after its one retry, while the camera's API itself answers.
- Breaker settings: 3 consecutive failures; probe interval `RECORDINGS_PROBE_MS`, default 60000.
- No FTP or gateway work: that waits for the camera gateway (see `~/Development/reolink/camera-gateway-design.md`).

## Review Focus

1. **Refused downloads:** while the breaker is open, a page of 25 thumbnails must cost the camera at most one probe per interval, not 25 refused transfers.
2. **Recovery:** when downloads start working again, the breaker must close on the first successful probe. Recordings must drop the banner at the next refresh.
3. **Return paths:** a cancelled Google sign-in must land on `/`, never on raw JSON, and must clear the state cookie.
4. **Session tokens:** a token signed with another algorithm (e.g. `none`, or HS512 with the same secret) must be rejected.
5. **Snapshot errors:** a snapshot that fails must show a message, not save an empty or HTML file.

---

### Task 1: Download-health breaker (server)

**Files:**
- Modify: `server/recordings/service.ts`, `server/routes/recordings.ts`, `test/mock-camera/cli.ts` (already has `MOCK_DROP_DOWNLOADS`)
- Test: `test/recordingsRoutes.test.ts`

**Interfaces:**
- `RecordingError` gains the code `'recordings_unavailable'`.
- `RecordingsService.downloadsState(cameraId): 'ok' | 'unavailable'`.
- `GET /events` → `{ date, events, downloads }`.

- [ ] Tests (fail first):
  - 3 refused thumbnails, then a 4th request → 503 `recordings_unavailable`, and the mock's download count doesn't grow;
  - the events response says `unavailable`;
  - after the probe interval (set to 50 ms in the test), a request that succeeds closes the breaker, and events say `ok`.
- [ ] Implement:
  - a `health` map per camera `{ failures, openedAt, lastProbeAt }`;
  - `downloadWithRetry` updates it: success resets it; a final `camera_offline` failure increments it;
  - `guard(cameraId)` runs before queueing any transfer (`withClip`, `openDownload`). While open, and not yet time to probe, it throws `recordings_unavailable`;
  - the route maps `recordings_unavailable` to 503.
- [ ] Run the full suite, then commit.

### Task 2: Recordings shows the state (web)

**Files:**
- Modify: `web/src/pages/Recordings.svelte`, `web/src/components/ClipPlayer.svelte`, `web/src/components/EventList.svelte`

- [ ] Recordings keeps `downloads` from each events load or refresh. When it's `'unavailable'`, it shows a banner (`data-testid="recordings-unavailable"`) above the player:

  > "The camera isn't serving recordings right now. This is a camera-side problem; live video, the list and Settings still work. cams retries every minute."
- [ ] ClipPlayer takes an `unavailable` prop. When it's true, a video error shows that same short reason instead of "This recording could not be loaded."
- [ ] Thumbnails stay placeholders; nothing else changes. Their 503s are cheap now.
- [ ] Component test: the banner appears when the events response says `unavailable`.

### Task 3: Auth and security follow-ups (Plan 1)

**Files:**
- Modify: `server/routes/auth.ts`, `server/session.ts`, `.github/workflows/production-checks.yml`, `.dockerignore`
- Test: `test/auth.test.ts`, `test/session.test.ts` (create if missing)

- [ ] **Cancelled sign-in.** `GET /auth/google/callback?error=…` (for example `access_denied`) clears the state cookie and redirects `302` to `/`. It never shows JSON. A missing `code` without `error` keeps today's 401.
- [ ] **Algorithm pinning.** `jwt.verify(token, secret, { algorithms: ['HS256'] })` and `jwt.sign(..., { algorithm: 'HS256', expiresIn: '7d' })`.
  - Tests: an HS512 token signed with the same secret is rejected, and so is a `none` token.
- [ ] **Dot segments in return paths.** `safeReturnPath` rejects `.` and `..` segments, raw or percent-encoded (`%2e`), for example `/app/../x` and `/app/%2e%2e/x`.
- [ ] **Workflow permissions.** Add top-level `permissions: contents: read` to `production-checks.yml`. The `codeql` job keeps its own, wider block.
- [ ] **Docker context.** Add `.superpowers` to `.dockerignore`.

### Task 4: UI follow-ups

**Files:**
- Modify: `web/src/pages/Live.svelte`, `web/src/components/CameraPicker.svelte`, `web/src/styles/theme.css`
- Test: e2e `e2e/live.spec.ts`, which keeps the existing snapshot test and adds the error case if feasible

- [ ] **Status fetch failure.** When `/status` itself fails (network or app down), set a new client-side code `'unreachable'` with the reason "cams couldn't check the camera (network or server problem)." `camera_error` keeps its wording.
- [ ] **Snapshot errors.** The snapshot control becomes a button that fetches the JPEG:
  - on success, it saves it through an object URL (filename unchanged);
  - on failure, it shows a short inline message (`data-testid="snapshot-error"`);
  - `data-testid="snapshot"` stays.

  Update the e2e check: clicking it triggers a download event.
- [ ] **Picker chevron colour.** It uses a theme token, `--select-chevron`, defined for dark and light (both media query and explicit attribute), so it re-tints in light mode.

### Task 5: Ship

- [ ] Full gate: unit tests ×2, build (no warnings), check, e2e.
- [ ] Final review.
- [ ] Open the PRs, deploy when green, then verify:
  - with the real camera currently refusing downloads, Recordings shows the banner;
  - pod logs show at most one probe per minute.
- [ ] Update the follow-up files: mark done items, and add anything new.
