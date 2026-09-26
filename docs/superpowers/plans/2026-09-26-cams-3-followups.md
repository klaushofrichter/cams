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
