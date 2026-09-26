# Plan 3 follow-ups

Deferred findings from the Plan 3 (recordings workspace) final review. None of them blocked
merging `feat/recordings`. Plan 1's and Plan 2's lists still apply.

## Timezones and freshness

- M1: the browser's timezone is assumed to match the camera's. A camera in a different zone
  from the viewer would show recordings under the wrong local date/time.
- M10: "today" views (the events list, the Live mini timeline) never refresh or roll over at
  midnight on their own. A tab left open past local midnight keeps showing yesterday's "today"
  until something else triggers a refetch.
- M11: the timeline's tick labels don't account for a DST transition within the visible day
  (the fall-back hour repeats, the spring-forward hour is skipped).

## Session and cold load

- M5: a cold-load session restore of a non-first camera via the sidebar isn't covered end to
  end (only the header-picker and same-page cases are).

## Downloads

- M12: paused downloads are cut after 10 s of inactivity. This is intended (bounds a stalled
  transfer holding a camera slot forever), not a bug.

## Tests

- The "does not evict while served" unit test for a clip's cached video is vacuous (it doesn't
  actually hold the response open across a concurrent evict). Make it real later with a
  held-open response, the way the download-abort tests hold a mock delay open.
- `days()` has no single-flight guard and its cache map is never bounded. The premise that a
  7-day window would grow this out of hand is false in practice (the list is per camera per
  month, entries are tiny, and there's one user), so this is left as is.
- NAME (in `server/recordings/clipNames.ts`) relies on regex backtracking to parse an
  all-decimal flags field; existing tests pin the current behavior but don't exercise pathological
  input.
- No test exercises the `webkitRequestFullscreen` fallback branch (older Safari) in
  `web/src/lib/fullscreen.ts`.
- `chicagoParts`'s CDT detection (`test/mock-camera/server.ts`) matches on the ICU short
  timezone name ("CDT"/"CST"); this is dependent on the ICU data bundled with Node and could
  drift on a different Node build.
- A pre-first-byte camera error on a download surfaces to the client as a raw socket reset
  rather than a 502; this was judged acceptable rather than fixed.
- The pre-header `sendFile` failure test patches Node's CJS `fs.stat` via `createRequire`
  (`test/recordingsRoutes.test.ts`) because `send` (used by `res.sendFile`) loads `fs` through
  its own `require()`, separate from the ESM `fs` module `vi.mock`/`vi.spyOn` can intercept.
  Noted as fragile; revisit if a `send` upgrade changes how it loads `fs`.

## Rulings made during execution (from the SDD ledger)

- Ruling R1: T6 sets `days = d.days` (drop the no-op Set expression) — noise in plan — cost if wrong: none.
- Ruling R2: T6 Recordings page loads days for the cursor's month AND the previous month and merges them, so day-prev works across a month boundary — e2e would fail on the 1st otherwise — cost: one extra cached Search per page load.
- Ruling R3: kube-setup notes exceeding 2Gi evicts the pod. The cap (1.5 GiB) is enforced after each fill; headroom 512 MiB >> in-flight temp files (sub clips ≤ ~2 MB, max 2 concurrent transfers per camera; main downloads are streamed, never cached) — no plan change — cost if wrong: pod eviction under an unforeseen burst; final review to check.
- Ruling R4: fix 1-9, 10 (calendar validation), 11 (per-worker CACHE_DIR); park days() single-flight and map bounding (7-day window, bounded in practice) — cost if wrong: small memory growth.
- Ruling R5: today TTL applies to dates >= cameraToday-1 — simplest cover for DST-enabled-inactive and midnight edge — cost: yesterday re-searched every 30 s while viewed.
- Ruling R6: no third re-review of T6; C1/I1/picker/zoom behaviours get permanent e2e in Task 7 and the final opus review covers the reactive code — cost if wrong: a defect found in final review instead.
- Ruling R7: Task 7's task-review folded into the final whole-branch opus review (tests + small Live change; reviewer instructed to cover it explicitly) — cost if wrong: one more fix wave.
