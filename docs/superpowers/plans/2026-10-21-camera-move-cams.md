# Camera move — cams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cams applies a camera move without a held change when the camera moves to a proxy an account admin has trusted once, and gains that once-per-proxy trust (a banner, seeded for proxies already in use).

**Architecture:** `TrustStore` (server/admin/trust.ts) gets a second map, trusted proxies per account, beside the per-camera confirmed values. `decide()` receives the camera's move context from `buildFleet`; a move-marked change that satisfies the rule is confirmed on the spot and logged. Proxy-level held items reach the admin through the existing held banner and routes, and cams-admin through the report's new `heldProxies`.

**Tech Stack:** TypeScript (Node, CommonJS), Express 5, Svelte 5, vitest (node + jsdom projects), Playwright.

**Spec:** `~/Development/cam-proxy/docs/superpowers/specs/2026-10-21-camera-move-design.md` §9.2 (cited **S §9.2**). Contract: cams-admin plan `docs/superpowers/plans/2026-10-21-camera-move-cams-admin.md` Task 1, `contract/cams-v1` (`proxies[].site`, `cameras[].moveId`, report `heldProxies`).

**Prerequisite:** cams-admin plan Task 1 merged.

## Global Constraints

- Every API route gets a line in `server/routes/access.ts`; every UI element used by e2e has a `data-testid`; e2e at 1440×900 and 390×844; colours from CSS tokens.
- Never log passwords, tokens or client IPs; trust logs carry ids, never values.
- `trust.json` stays mode 600; a file written by the current release must load (no downgrade support: Ruling M4).
- User-visible changes under `## [Unreleased]` in CHANGELOG.md.
- The real camera / livestack real-camera part only with Klaus's OK.

## Rulings

- **M1 — Trusted proxy key and values.** Key `<accountId>/<proxyId>`; values `{proxyUrl, caFingerprints (normalised, sorted), proxyTlsServername}` — the three proxy fields of `TrustValues`, compared with the same `differs`. A proxy whose offered values differ from its trusted ones is a held proxy item (banner) and is not trusted for moves until confirmed again.
- **M2 — Seeding.** Once (when `trust.json` has no `proxies` key): for each confirmed camera whose current snapshot offer has the same three proxy values as its confirmed values, trust that proxy (key from the snapshot's `camera.proxyId`). Logged as action `seed-proxies`. Existing installs need no click for proxies they already use (S §9.2).
- **M3 — The move rule (S §9.2).** `decide()` confirms an offer without a hold when all hold: the snapshot camera has a non-null `moveId`; a confirmed entry exists for the camera; the offered proxy (by `camera.proxyId`) is trusted with exactly the offered three proxy values; `host` and `protocol` equal the confirmed ones; the offered `tlsServername` equals `<proxyCameraId>.<site>.internal` where `site` is the offered proxy's snapshot `site` (non-null). It writes `confirmed[key] = offered`, clears `keptOld`, logs `{action:'move', moveId}` and a pino `camera_moved_trusted`. Anything else falls through to today's behaviour.
- **M4 — No downgrade path.** An older cams reading a `trust.json` with `proxies` drops the key on its next save (documented in CHANGELOG). Acceptable: the seed runs again after re-upgrade.
- **M5 — Proxy banner actions.** Confirm only (like a new camera has no Keep old). The banner shows proxy items first: "New proxy <name> at <url>, certificate <first 8 of the pin>…: Confirm". A proxy item is digest-bound like camera items (`offerDigest` variant over `{proxyId, offered, revision}`).

## Review Focus

1. A move-marked offer arrives while the target proxy's trust is itself held (its pin changed): the camera change is held too, never applied with the new pin — Task 3 `move to a proxy with a held pin is held`.
2. The snapshot keeps `moveId` set after the move (cams-admin clears it at done): a later, unrelated change of the same camera (e.g. a host change) is still held — Task 3 `moveId does not excuse a host change`.
3. A viewer (non-admin) session calls the proxy confirm route: 403 and nothing changes — Task 4 `viewer cannot confirm a proxy`.
4. Two accounts have a proxy with the same id string in fixtures: trust is per account, confirming in one does not trust in the other — Task 2 `proxy trust is per account`.
5. `trust.json` from the current release (no `proxies`) loads, seeds once, and a second start does not seed again — Task 2 `seeds once`.

---

### Task 1: Vendor cams-v1 and read the new fields

**Files:**
- Run: `scripts/contract/vendor-cams-v1.sh` (updates `contract/cams-v1/`)
- Modify: `server/admin/snapshot.ts` (`SnapProxy.site: string|null`, `SnapCamera.moveId: string|null`; `checkAccount` :62-68 validates `moveId` as `null` or `^mv_[0-9A-HJKMNP-TV-Z]{20}$`, `site` as `null` or `^[a-z0-9][a-z0-9-]{0,31}$`; a cached snapshot without the fields reads them as null)
- Modify: `test/admin/snapshots.ts` (`snapCamera({moveId})`, proxy `site` default `'alpha'`)
- Test: `test/admin/snapshot.test.ts`, `test/contract/*`
- [ ] **Step 1: Failing tests:** `camera moveId is read and validated`; `a bad moveId fails the account (last good part kept)`; `proxy site is read`; `a cached snapshot without site and moveId still applies`; contract drift test green with the new vendored copy.
- [ ] **Step 2: Run** `npx vitest run test/admin/snapshot.test.ts test/contract` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint:types` — PASS.
- [ ] **Step 5: Commit** `feat(admin): read proxy site and camera moveId from the snapshot`.

### Task 2: Trusted proxies in TrustStore

**Files:**
- Modify: `server/admin/trust.ts` (FileShape gains optional `proxies: Record<string, ProxyTrust>`; constructor keeps it; load validates it; `log` action union adds `'seed-proxies'|'confirm-proxy'|'move'`), `server/admin/apply.ts` (types `ProxyTrust`, `HeldProxy`), `server/configSource.ts` (`seedTrustOnce` also calls `seedProxiesOnce(snapshotAccounts)` before `buildFleet`)
- Test: `test/admin/trust.test.ts`

**Interfaces:**
- Produces:
  - `type ProxyTrust = { proxyUrl: string|null; caFingerprints: string[]; proxyTlsServername: string|null }`
  - `type HeldProxy = { accountId: string; proxyId: string; name: string; fields: ('proxyUrl'|'caFingerprints'|'proxyTlsServername')[]; trusted: ProxyTrust|null; offered: ProxyTrust; digest: string }`
  - `TrustStore.seedProxiesOnce(accounts: {id: string; proxies: SnapProxy[]; cameras: SnapCamera[]}[]): void` (M2)
  - `TrustStore.proxyOffer(accountId, proxy: SnapProxy, revision): void` (records the offer, like `offers`)
  - `TrustStore.isTrusted(accountId, proxyId, offered: ProxyTrust): boolean`
  - `TrustStore.heldProxies(accountId?): HeldProxy[]`
  - `TrustStore.confirmProxies(email, accountId, items: {proxyId, digest}[]): {confirmed: string[]; changed: string[]}` (all-or-nothing digest check, as `act()`)
- [ ] **Step 1: Failing tests:** `old trust.json without proxies loads`; `seeds once` (second start does not seed; log has one `seed-proxies`); `seeding trusts only proxies whose offer equals a confirmed camera's values`; `a proxy with a changed pin is held and not trusted`; `confirmProxies with a stale digest changes nothing`; `proxy trust is per account` (Review Focus 4); `proxies survive a save of a camera confirm`.
- [ ] **Step 2: Run** `npx vitest run test/admin/trust.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(admin): trusted proxies, seeded once`.

### Task 3: The move rule

**Files:**
- Modify: `server/admin/trust.ts` (`decide(accountId, camsId, offered, move?: {moveId: string; proxyId: string; proxyCameraId: string; site: string|null}): …`), `server/admin/apply.ts` `buildFleet` (:61-64: pass the move context from `SnapCamera.moveId`, `proxyId`, `proxyCameraId` and the proxy's `site`; call `proxyOffer` for every proxy)
- Test: `test/admin/trust.test.ts`, `test/admin/apply.test.ts` (or the existing buildFleet test file)

**Interfaces:**
- Consumes: Task 2 `isTrusted`.
- Produces: `decide` result unchanged in shape; on the M3 path `{use: offered, confirmed: true, held: null}` and the store saved.
- [ ] **Step 1: Failing tests:** `move to a trusted proxy applies without a hold and logs move`; `move to an untrusted proxy is held`; `move to a proxy with a held pin is held` (Review Focus 1); `move with a changed host is held`; `move with a TLS name not under the site is held`; `moveId does not excuse a host change` (Review Focus 2); `a move-confirmed camera gets its password binding` (buildFleet: `confirmed===true` → token and password used).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(admin): apply camera moves to trusted proxies without a hold`.

### Task 4: Routes, banner and report

**Files:**
- Modify: `server/routes/accounts.ts` (`GET /api/admin/held` adds `proxies: HeldProxy-view[]` `{proxyId, name, fields, from, to, digest}`; new `POST /api/admin/held/proxies/confirm` body `{items:[{proxyId (^prx_[0-9A-HJKMNP-TV-Z]{20}$), digest (64 hex)}]}` max 64 → 409 `offer_changed` / `{confirmed}`; then `reapplyConfig()`, `resetClients()`, pino `held_proxy_confirmed`, `reportSoon(true)`), `server/routes/access.ts` (the new route: `'admin'`), `server/routes/api.ts` (`/api/me` `held` counts proxy items too), `server/admin/report.ts` (`heldProxies` up to 64), `web/src/components/HeldBanner.svelte`, `web/src/lib/stores.ts`
- Test: `test/heldRoutes.test.ts`, `test/admin/report.test.ts`, `web/src/components/AccountBanners.svelte.test.ts`, `e2e/held.spec.ts`
- Copy (exact): proxy item text `New proxy <name> at <url> (certificate <first 8 hex of the first pin>…)` or, for a change, `Proxy <name>: <label> <from> → <to>`; button `Confirm` (`data-testid="held-proxy-confirm-<proxyId>"`), item `data-testid="held-proxy-<proxyId>"`; help line under proxy items: `Confirm a proxy once; cameras can then move to it without asking again.`
- [ ] **Step 1: Failing tests:** `held lists a new proxy`; `confirming a proxy trusts it and the next move to it applies without a hold` (fake admin: snapshot 1 adds proxy B, confirm, snapshot 2 moves cam1 from A to B with moveId → no held item, camera connects via B); `viewer cannot confirm a proxy` (Review Focus 3); `stale digest is 409`; `report carries heldProxies`; banner component test renders proxy items before camera items and posts `{proxyId, digest}`; e2e `confirm a new proxy from the banner`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run check && npm run build && npm run test:e2e` — PASS.
- [ ] **Step 5: Commit** `feat: confirm a proxy once; held proxies in the banner and the report`; CHANGELOG: "Proxies are confirmed once per account; cameras moved to a confirmed proxy switch over without a held change."

### Task 5: Livestack check

**Files:**
- Modify: `scripts/livestack/two-proxy.spec.ts`, `scripts/livestack/check-two-proxy.sh`, `docs/livestack.md`
- [ ] **Step 1:** Extend the two-proxy livestack with a cams-admin-mode scenario using the fake admin: proxy B new → banner → Confirm → snapshot moves the camera to B with `moveId` and `<cam>.<siteB>.internal` → live view and a recording play through B without any held banner.
- [ ] **Step 2: Run** `scripts/livestack/check-two-proxy.sh` — Expected: the new scenario passes (sim cameras only; no real camera).
- [ ] **Step 3: Commit** `test(livestack): camera move to a confirmed proxy`.
