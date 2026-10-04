# Still checks on the Timeline: plan (cams #179, phase 2)

Spec: `docs/superpowers/specs/2026-10-04-still-checks-ui-design.md`. TDD: each
task's tests first, watched failing, then the code.

1. **Fake proxy** (`test/proxy/fakeProxy.ts`): the contract's routes
   (`POST/GET still-checks`, `GET …/{id}`, `…/{id}.jpg`, `GET analytics`),
   state (`checks`, `analytics`, `checkFailure`, `checkDelayMs`), reuse from a
   stored check or an analysis with that still, the `still-check` message;
   e2e hooks `POST /stills-minute` (a minute of 1 fps stills and a sprite).
2. **Parsing** (`server/proxy/stillChecks.ts`): `parseCheck`, `parseUsage`,
   linked events; `CheckStore` (day cache, invalidated by `still-check`).
3. **Routes** (`server/routes/stillChecks.ts`): the five relays, the
   per-user limits (`createCheckRateLimits` in `middleware/rateLimit.ts`),
   the image path in the image bucket. Tests in `test/stillChecksRoutes.test.ts`.
4. **Stream**: `still-check` in `TYPES` and `OPTIONAL`; the relay's `change`
   with `ts: stillTs`. Tests in `test/proxyStream.test.ts`.
5. **Cards**: `attachAnalyses(cards, analyses, checks)`; `GET /events` reads
   the day's checks. Tests in `test/analyses.test.ts`.
6. **Web lib** (`web/src/lib/stillChecks.ts`): button state, texts, marks,
   prev/next; `eventStream.onChange`. Tests beside it.
7. **Timeline**: `StillCheck.svelte` (button, usage, result, errors),
   `ChecksList.svelte`, marks, chip, ◀ ✧ ▶, Shift+arrows, live refresh. Tests
   in `Timeline.svelte.test.ts` / `StillCheck.svelte.test.ts`.
8. **Vision dialog**: checks among a card's stills, "✧ checked by hand",
   objects from the check.
9. **e2e** `e2e/still-checks.spec.ts` (desktop, phone), screenshots.
10. README, CHANGELOG; lint:types, vitest, check, check:svelte, build, e2e.
