# Plan 1 follow-ups (carry into Plan 2)

Deferred findings from the Plan 1 task reviews and the final whole-branch review.
None blocked the first production deploy (v2026.09.25.1). Triage per the final review.

## Should do early in Plan 2
- Auth tests: assert `getToken` is not called when `state` is invalid (ordering is only guarded by a comment); 429 on login/callback; reselect-then-allowed path.
- Replace the logout→/api/me unit test that can't fail (supertest carries no cookies) with a signed-session before/after test.
- Cancelled Google sign-in (`?error=access_denied`) shows raw JSON 401 — redirect to `/` instead (more common now that the account chooser always shows).
- After deploy, verify rate-limit buckets are per client: compare `RateLimit-*` headers from two networks. If they share a bucket, revisit trust proxy / ingress source IP.
- svelte-check once it supports TypeScript 7 (today `npm run check` is tsc over web/*.ts only; .svelte files are not type-checked).

## Hardening / polish
- deploy-production.yml harvests `## [Unreleased]` into the release but never clears it on main (siblings do); add the reset step.
- `jwt.verify` with explicit `algorithms: ['HS256']`.
- `safeReturnPath` accepts dot segments (`/app/../x`) — same-origin, but escapes `/app`.
- Clear `oauth_state` on 401 paths and `return_to` on 403.
- Error handler throws on a literal `null`/`undefined` error value.
- `permissions: contents: read` on the `test`/`e2e` PR-check jobs.
- `.dockerignore`: exclude `.superpowers/`.
- Sidebar modified-click guard: add `altKey`.
- Camera picker chevron colour is baked into a data URI (doesn't re-tint in light theme).
- App `load()` has no retry for non-401 failures.
- Drawer has no Tab focus trap (initial/return focus only).
- `test/config.test.ts` restore could write the string "undefined".
- Registry id error message interpolates the regex literal.
- Stale-free now, but keep: Lens mark and camera illustration are brand artwork with fixed colours (exempt from theme tokens by ruling).
