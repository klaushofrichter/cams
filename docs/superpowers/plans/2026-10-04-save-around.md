# Save clip around a second (#179 phase 3, cams) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, test first. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Save clip around this" under the Timeline's large still opens the Save dialog anchored at that second (−10/+10 s by default), composed by cam-proxy from FTP clips and 1 fps stills.

**Architecture:** `ComposeDialog` gains an `at` mode (props `at`, `stillSrc`); `web/src/lib/compose.ts` gains the at-mode ranges, `planAround` (dry run) and the start body; the cams server's compose relay validates and relays `at`, names the file in camera time; the fake proxy mirrors cam-proxy's §13 rules.

**Spec:** `docs/superpowers/specs/2026-10-04-still-checks-ui-design.md` §5 (rulings 11–19); cam-proxy's still-checks spec §13.

## Tasks

### Task 1: limits and names (lib)
**Files:** `server/clipLimits.ts`, `test/clipLimits.test.ts`, `web/src/lib/compose.ts`, `web/src/lib/compose.test.ts`.
- [ ] Tests: `AT_LENGTH_CASES` (cam-proxy's table) through `resultLength(1, …)`; `aroundRanges` (0 to the limit, post capped at the seconds past); `madeOf` texts; `aroundName` in a zone.
- [ ] Implement; commit.

### Task 2: the relay
**Files:** `server/routes/compose.ts`, `test/compose*.test.ts`, `test/proxy/fakeProxy.ts`.
- [ ] Tests: 400s (both anchors, at string/fraction/not whole/future/too old, negative roll, over 300 s / 120 s); relays `{at,…}`; dry run 200 and 409 pass through; 201 remembered and named in camera time (fallback zone); fake proxy's 409 for nothing covered.
- [ ] Implement; commit.

### Task 3: the dialog and the Timeline
**Files:** `web/src/components/ComposeDialog.svelte`, `ComposeDialog.svelte.test.ts`, `StillCheck.svelte`, `web/src/pages/Timeline.svelte`, Timeline component test.
- [ ] Tests: title, defaults 21s, no 4K, rolls at every size, limits at 1080p, post capped, made-of line, nothing → Generate off, start body, name on Save; the Timeline button opens the dialog at that second; the result line's link.
- [ ] Implement; commit.

### Task 4: e2e, docs
**Files:** `e2e/save-around.spec.ts`, `e2e/fakeProxyData.ts`, `README.md`, `CHANGELOG.md`.
- [ ] e2e (desktop, phone): around a stills-only second; around a clip second; refused where nothing covers it. Screenshots of the dialog (desktop/phone, light/dark) to the scratchpad.
- [ ] Full checks: `npm test`, `npm run build`, `npm run check`, `npm run lint:types`, `npm run test:e2e`; commit.
