# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/mcp` on cams: read tools over one account's cameras and content for an LLM, behind personal bearer tokens issued on Settings.

**Architecture:** A stateless Streamable HTTP MCP server per request (`@modelcontextprotocol/sdk`). The bearer token resolves to its issuer's current principal; every tool calls cams's own `/api` routes over loopback with an in-process secret plus the token id, so the role table and isolation apply unchanged. Videos leave as HMAC-signed 15-minute links served by `/mcp/media`.

**Tech Stack:** Express 5, TypeScript, `@modelcontextprotocol/sdk@1.32.1`, `zod@4.6.7`, ffmpeg, vitest + supertest + cam-sim + fakeProxy, Svelte 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-mcp-server-design.md`

## Global Constraints

- SDK pinned exactly `@modelcontextprotocol/sdk@1.32.1`, `zod@4.6.7` (already installed, package.json exact).
- Token format `cmcp_` + 32 random bytes base64url; ids `mtk_` + 20 base32 chars; hash `sha256:<hex>`.
- Days 1–90, default 30. Caps: 3 live per (account, issuer email), 20 per account → 409 `too_many_tokens`.
- File `<dataDir()>/mcp/tokens.json` (`MCP_TOKENS_FILE` overrides), 600 in 700, `checkPrivate`/`writePrivate` from `server/admin/keyfile.ts`.
- `/mcp` only when `MCP_ENABLED=true`; with `cookieSecure()` false also `MCP_ALLOW_HTTP=true`; else 404.
- Limits: per token 60/min and 2000/day; per account 300/min; generate_clip 1 in flight per account, 10/hour per account; media 30/min per token; bad bearer 10 per 15 min per address. Env overrides for tests: `RATE_LIMIT_MCP_PER_MIN`, `RATE_LIMIT_MCP_PER_DAY`.
- Images: default 1024 (snapshot) / 768 (event, archive); maxWidth 320–1568; 400 KB per image (retry once at `-q:v 12`), 4 images and 1.2 MB per result.
- Links expire 15 min (composition: min(15 min, doneAt + 15 min)).
- Never log tokens, the internal secret or image bytes. Never commit `.superpowers/`.

## Review Focus

- A token whose issuer was removed from the account mid-session: next call 401 (Task 2 test `issuer removed`).
- The same camsId `cam1` in two accounts: token of ALPHA reaches only ALPHA's proxy (Task 8).
- A link replayed after the token is revoked: 403 `link_invalid` (Task 6).
- Internal headers sent from outside with a guessed secret: 401, never the cookie's account (Task 2).
- A long `generate_clip` with the client gone: cams keeps polling so the proxy doesn't cancel it at 30 s (Task 7).

---

### Task 1: Config and token store

**Files:** Create `server/mcp/config.ts`, `server/mcp/tokens.ts`; Test `test/mcp/tokens.test.ts`, `test/mcp/config.test.ts`

**Interfaces — Produces:**
- `mcpMode(env?): 'off' | 'on' | 'http-refused'`; `mcpEnabled(): boolean` (`=== 'on'`); `mcpPlainHttp(): boolean`.
- `interface McpIssuer { email: string; via: 'google' | 'token'; tf?: string }`
- `interface McpTokenView { id; name; accountId; issuer: string /* email */; scopes: string[]; createdAt; expiresAt; revokedAt: number|null; revokedBy: string|null; lastUsedAt: number|null; callsToday: number; state: 'active'|'expired'|'revoked' }`
- `class McpTokens { static load(file?): McpTokens; issue(accountId, issuer: McpIssuer, input: unknown): {token: string; item: McpTokenView}; list(accountId, filter?: {issuer?: string}): McpTokenView[]; revoke(accountId, id, by: string, ownerOnly?: string): McpTokenView | null; find(token: string): StoredToken | null; byId(id): StoredToken | null; touch(id): void }`
- `getMcpTokens(): McpTokens` (lazy singleton), `resetMcpTokens(): void` (tests).
- Errors: `class McpTokenError extends Error { status: 400|404|409; code: 'invalid'|'not_found'|'too_many_tokens'; field? }`.

- [ ] Step 1: tests — `issue` returns `cmcp_` token of length 5+43, file holds only `sha256:` hash (grep the file text for the token: absent), file mode 0o600 and folder 0o700; days 0/91/1.5 and empty name → `invalid`; 4th live token same issuer → 409, 21st in account → 409, revoked/expired don't count; `find` refuses expired, revoked, wrong prefix, >128 chars; a second `McpTokens.load` instance sees a revoke after the file's mtime changes (wait >1 s or set mtime with `utimesSync`); `list(acc, {issuer})` never contains `hash`/`token`; revoke with `ownerOnly` of another email → null. Config: off by default; on with `MCP_ENABLED=true`; `COOKIE_SECURE=false` without `MCP_ALLOW_HTTP` → `http-refused`.
- [ ] Step 2: run `npx vitest run test/mcp` → FAIL.
- [ ] Step 3: implement; re-read the file when `statSync(file).mtimeMs` changed, at most once a second; every write re-reads first; prune entries 30 days past expiry/revoke on write.
- [ ] Step 4: tests PASS. Step 5: commit.

### Task 2: Principal sharing and internal calls

**Files:** Modify `server/middleware/requireAuth.ts`, `server/middleware/rateLimit.ts`, `server/logger.ts` (redact list); Create `server/mcp/internal.ts`, `server/mcp/auth.ts`; Test `test/mcp/internal.test.ts`, `test/mcp/auth.test.ts`

**Interfaces — Produces:**
- `principalIn(id: {email; via: 'google'|'token'; tf?: string}, accountId: string): Principal | null` in requireAuth.ts (token via: same checks as `authState`'s token branch; google: `membershipsOf(email)` entry for accountId). `Principal.via` gains `'mcp'`, and `Principal` gains optional `mcpTokenId?: string`.
- `mcpPrincipal(t: StoredToken): Principal | null` in `server/mcp/auth.ts` → `{...principalIn(...), via: 'mcp', email: issuer email, mcpTokenId}`; `bearerPrincipal(header: string|undefined): {token: StoredToken; principal: Principal} | null`.
- `INTERNAL_HEADER = 'x-cams-internal'`, `TOKEN_HEADER = 'x-cams-mcp-token'`, `isInternal(req): boolean`, `internalPrincipal(req): Principal | null`, `callApi(base: InternalBase, tokenId, path, init?: {method?; body?; headers?}): Promise<Response>` (undici/global fetch; `InternalBase = {host: string; port: number}`), `internalBaseOf(req): InternalBase`.
- `requireAuthApi`: if any internal header present → `internalPrincipal` or 401; path starting `/api/mcp-tokens` → 403 `forbidden`.
- `createApiRateLimit/Media/Image` skip internal requests.

- [ ] Step 1: tests — `principalIn` for google member/viewer/removed/disabled, token-login with changed token → null; internal call with right secret and live token reaches `/api/cameras` with token's account and ignores a cookie of another account; wrong secret → 401; secret right but token revoked → 401; internal request to `/api/mcp-tokens` → 403; bearer for issuer removed from account → null.
- [ ] Step 2: FAIL. Step 3: implement (`timingSafeEqual` on equal-length buffers). Step 4: PASS plus `npx vitest run test/requireAuth.test.ts test/auth.test.ts test/rateLimit.test.ts`. Step 5: commit.

### Task 3: Token API

**Files:** Create `server/routes/mcpTokens.ts`; Modify `server/routes/api.ts`, `server/routes/access.ts`, `server/routes/api.ts` `/api/me` (adds `mcp: {enabled, plainHttp}`); Test `test/mcp/tokenRoutes.test.ts`

**Interfaces — Produces:** `GET /api/mcp-tokens[?all=1]` → `{items: McpTokenView[], enabled, plainHttp}` (all=1 only admins, else 403 `forbidden_role`); `POST /api/mcp-tokens {name, days}` → 201 `{token, item, endpoint}`; `POST /api/mcp-tokens/:tokenId/revoke` → 200 `{item}` / 404. Access lines: `GET /api/mcp-tokens` viewer, `POST /api/mcp-tokens` viewer, `POST /api/mcp-tokens/:tokenId/revoke` viewer (+ in `VIEWER_WRITES`). Audit lines `mcp_token_issue`, `mcp_token_revoke`.

- [ ] Step 1: tests — viewer issues own; list shows only own; admin `?all=1` sees others with issuer; viewer `?all=1` 403; viewer can't revoke another's (404); admin can; cross-origin POST 403; ALPHA admin can't see/revoke BETA tokens; log line never contains the token.
- [ ] Step 2–5: FAIL, implement, PASS (`test/access.test.ts` too), commit.

### Task 4: The /mcp endpoint and list_cameras

**Files:** Create `server/mcp/router.ts`, `server/mcp/server.ts`, `server/mcp/limits.ts`, `server/mcp/result.ts`, `server/mcp/tools/cameras.ts`; Modify `server/app.ts` (mount before `apiRouter`), `server/config.ts` (warn `mcp_http_refused`); Test `test/mcp/endpoint.test.ts`, `test/mcp/helpers.ts`

**Interfaces — Produces:**
- `interface ToolCtx { principal: Principal; tokenId: string; api: (path, init?) => Promise<Response>; origin: string; log: (fields) => void }`
- `result.ts`: `ok(data, images?: {data: Buffer; mime: 'image/jpeg'}[]): CallToolResult`, `fail(code, message, retryable?): CallToolResult`, `fromStatus(res: Response): CallToolResult` (maps `/api` JSON errors to §8 codes), `parseTime(v: string|number): number|null`.
- `server.ts`: `buildServer(ctx: ToolCtx): McpServer` registering every tool module's `register(server, ctx)`.
- `test/mcp/helpers.ts`: `startApp(): {url, close}`, `mcpClient(url, token): Promise<Client>`, `issueToken(accountId, email, role?)`.

- [ ] Step 1: tests (SDK `Client` + `StreamableHTTPClientTransport` against a listening app) — no token 401 with `WWW-Authenticate`; revoked 401; `/mcp` 404 when off; 404 when `COOKIE_SECURE=false` without opt-in, works with `MCP_ALLOW_HTTP=true`; GET 405; foreign Origin 403; `listTools` names exactly the ten tools; `list_cameras` returns file-mode cameras with `hasProxy`; 61st call in a minute → 429 (with env lowered); log line `mcp_call` has tool and token id, no `cmcp_`.
- [ ] Step 2–5.

### Task 5: Images, snapshot, events, search

**Files:** Create `server/mcp/images.ts`, `server/mcp/tools/events.ts`, `server/mcp/tools/snapshot.ts`; Test `test/mcp/images.test.ts`, `test/mcp/eventTools.test.ts`

**Interfaces — Produces:** `scaleJpeg(input: Buffer, maxWidth: number): Promise<{data: Buffer; width: number}>` (throws `image_too_large`), `datesCovering(from, to): string[]` (UTC dates from from−1 day to to+1 day), `toEvent(card): Event`.

- [ ] Step 1: tests — `scaleJpeg` of a 1920 px ffmpeg test pattern at 640 → width 640 and < 400 KB; never upscales; `get_snapshot` on cam-sim with no proxy → `source: camera` and an image block; with a fresh fake-proxy still → `proxy-still`; `list_events` range > 7 days → `range_too_large`; kinds filter; `get_event` unknown id → `not_found`, images=2 → ≤ 2 image blocks; `search_recordings` over a month with `kinds: ['person']` only returns person hits, `daysSearched` counts only recording days.
- [ ] Step 2–5.

### Task 6: Links, media route, archive tools

**Files:** Create `server/mcp/links.ts`, `server/mcp/tools/archive.ts`; Modify `server/mcp/router.ts` (`GET /mcp/media/:link`), `server/mcp/tools/events.ts` (`get_event.video`); Test `test/mcp/links.test.ts`, `test/mcp/archiveTools.test.ts`

**Interfaces — Produces:** `signLink(p: {tok; acc; cam; kind; ref; exp}): string`, `verifyLink(s): LinkPayload | 'invalid' | 'expired'`, `linkUrl(origin, payload): string`, `mediaPath(p): string` (clip → `/api/cameras/:cam/clips/:ref/download?quality=sub`, composition → `/api/cameras/:cam/compositions/:ref/video`, archive → `/api/archive/:via/items/:id/video?download=1`).

- [ ] Step 1: tests — round trip; one changed byte → invalid; exp past → 410; revoked token → 403; issuer removed → 403; Range header passes (206 from archive video of fake proxy); `list_archive` returns `ref` `cam1:<id>`; `get_archive_clip` bad ref `../x` → `invalid`; unknown → `not_found`.
- [ ] Step 2–5.

### Task 7: generate_clip, get_clip_job, analytics_usage

**Files:** Create `server/mcp/jobs.ts`, `server/mcp/tools/clips.ts`, `server/mcp/tools/analytics.ts`; Test `test/mcp/clipTools.test.ts`

**Interfaces — Produces:** `class McpJobs { start(accountId, tokenId, cam, run: () => Promise<{id}>): ...; get(tokenId, job) ; keepAlive }` with poll every `MCP_JOB_POLL_MS` (10 000) until terminal or 10 min; `resetMcpJobs()`.

- [ ] Step 1: tests (fake proxy compositions) — around range → posts `{at, preS: 0, postS}`; done within wait → `video.url`; second while first running → `busy`; 11th in an hour → `rate_limited`; keep-alive polls the fake proxy's job while no client asks; `get_clip_job` of another token → `not_found`; `analytics_usage` returns parsed usage and `{camera, error: 'no_proxy'}` is omitted for cameras without proxy.
- [ ] Step 2–5.

### Task 8: Isolation

**Files:** Test `test/mcp/isolation.test.ts`; Modify `test/isolationScan.test.ts` (scan `server/mcp/` for all-accounts calls)

- [ ] Step 1: two accounts (`test/helpers/fleet.ts`), ALPHA token: `list_cameras` names only Alpha cam; `get_snapshot cam1` hits only ALPHA's proxy/camera; `list_archive` only alpha items; a BETA link payload signed for ALPHA token → 403.
- [ ] Step 2–5.

### Task 9: Settings card and e2e

**Files:** Create `web/src/components/McpTokensCard.svelte`, `web/src/lib/mcpTokens.ts`, `web/src/components/McpTokensCard.svelte.test.ts`, `e2e/mcp.spec.ts`; Modify `web/src/pages/Settings.svelte`, `web/src/lib/api.ts` (if a helper is missing), `e2e/env.ts` (`MCP_ENABLED`, `MCP_ALLOW_HTTP`, `MCP_TOKENS_FILE`), `playwright.config.ts` (remove the token file at start).

- [ ] Step 1: component test — renders own list, issue shows token once with the `claude mcp add` line, plain-http warning when `plainHttp`, admin "All tokens" section only for admins. e2e: issue → copy line visible → revoke (desktop + phone); SDK client: listTools, `list_cameras`, `get_snapshot` returns an image (desktop only).
- [ ] Step 2–5. Run `npm run check:svelte`, `npm run lint:types`.

### Task 10: Docs

**Files:** `README.md` ("MCP server" section, env table rows), `web/public/llms.txt`, `CHANGELOG.md` Unreleased; `test/llmsTxt.test.ts` if it pins content.

- [ ] Steps: write, run `npx vitest run test/llmsTxt.test.ts`, commit.
