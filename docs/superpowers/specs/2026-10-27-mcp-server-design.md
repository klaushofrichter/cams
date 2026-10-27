# MCP server in cams

2026-10-27. An MCP endpoint at `https://cams.skylar.technology/mcp` that gives
an LLM (Claude Code, Claude Desktop, any MCP client) read access to **one
account's** cameras and content, with a per-account bearer token. Klaus
approved the concept ("Can we offer an MCP for an account … protected by a
token for a specific account?"; "The read-only tools should also give access
to content, like thumbnails, archive and possibly generate clips"). **The
public endpoint itself still needs his approval, and kube-setup must be
informed before it is switched on in the cluster (§9).**

## 1. Intent

Ask an assistant "who came to the door this afternoon?", "show me the porch
now", "make me a clip of 14:02 to 14:04 on cam1": it lists events with their
AI labels, looks at stills and thumbnails, finds archived clips, and hands back
short-lived links to videos. Nothing it does changes a camera, a proxy or the
archive.

## 2. Goals and non-goals

Goals:
- MCP Streamable HTTP on the existing cams Express server, path `/mcp` on the
  existing host and port. Official SDK `@modelcontextprotocol/sdk`, pinned
  exactly to **1.32.1** (published 2026-10-05; 1.32.2 is from 2026-10-23, too
  new). Its `zod` dependency comes with it.
- One token, one account, explicit scopes. Phase 1 has the single scope `read`.
- Tool calls go through the same server code as `/api` (`getRecordings()`, the
  proxy clients, the archive and still-check parsers), never an HTTP loopback
  and never a second path to a camera.
- Images as MCP image content, scaled down. Videos only as signed links.

Non-goals (phase 1):
- Writes. **Phase 2** may add a `write` scope with `archive_clip` and
  `save_clip_around` (archive the result); still checks (they spend the
  Vision budget) would go there too. Camera settings, the light, reboot, rename,
  the proxy switch and anything else that changes a camera or proxy stay out
  for good.
- OAuth 2.1 for claude.ai custom connectors: a later phase (the SDK has the
  pieces; the bearer token stays for CLI clients).
- Live video, the event stream (SSE) as MCP notifications, MCP resources and
  prompts. Tools only.

## 3. Tools

Common rules. `camera` is the account's camera id (`cam1`), as on `/api`.
Times in are ISO 8601 with an offset or unix ms; times out are both
(`startMs` plus `start`, ISO in the camera's offset when cams knows it, else
UTC). Every tool returns `structuredContent` (the JSON below, declared as its
`outputSchema`) plus the same JSON as one text block for older clients.
Images are extra `image` blocks. Lists are capped and say `truncated: true`.

| Tool | Input | Output (structuredContent) |
|---|---|---|
| `list_cameras` | `{}` | `{cameras: [{id, name, online: true\|false\|null, model, simulated, hasProxy, lastEvent: {id, startMs, start, kinds[]} \| null}]}` (status from the 10-min cache; `lastEvent` from today's list, else yesterday's) |
| `get_snapshot` | `{camera, maxWidth?: 320–1568 = 1024}` | `{camera, takenAtMs, source: "proxy-still"\|"camera", width, height}` + 1 image. The proxy's newest still when it is under 5 s old, else the camera's snapshot |
| `list_events` | `{camera, from, to, kinds?: ("person"\|"vehicle"\|"pet"\|"motion"\|"timer")[], limit?: 1–200 = 100}`; `to − from` ≤ 7 days | `{camera, events: [{id, startMs, endMs, start, end, durationS, kinds[], counts: {person?, vehicle?, pet?}, vision: {confirmed: kind[], notConfirmed: kind[], best: {kind: score}} \| null, hasThumbnail}], truncated}` (`id` is the clip id `YYYYMMDD-HHMMSS-HHMMSS`; days read as on the Video page, camera-local) |
| `get_event` | `{camera, eventId, images?: 0–4 = 1, maxWidth? = 768}` | `{event: <as above>, analyses: [{stillTs, kind, objects: [{name, score, box}]}], checks: [{checkId, ts, findings}], video: {url, expiresAt, quality: "sub"}}` + the card thumbnail and up to 3 analysed stills as images |
| `search_recordings` | `{from, to, cameras?: id[], kinds?, visionConfirmed?: bool, minDurationS?, limit?: 1–200 = 50}`; range ≤ 31 days | `{hits: [{camera, id, startMs, start, durationS, kinds[], visionConfirmed: kind[]}], daysSearched, truncated}`. Uses each month's `days` first, so empty days cost nothing; newest first |
| `list_archive` | `{q?, labels?: string[], cameras?, from?, to?, sort?: "recorded"\|"created" = "recorded", order?, limit?: 1–100 = 50}` | `{items: [{ref: "<via>:<id>", name, camera, cameraName, recordedFromMs, recordedToMs, durationS, quality, bytes, labels, expiresAtMs \| null}], unavailableProxies: [name], truncated}` |
| `get_archive_clip` | `{ref, thumbnail?: bool = true}` | `{item: <as above, plus eventKinds, source>, video: {url, expiresAt}}` + the thumbnail image |
| `generate_clip` | `{camera, start, end, size?: "sd"\|"360p"\|"720p"\|"1080p" = "sd", badge?: bool = true}` or `{camera, eventId, preS?, postS?, size?, badge?}`; length rules of `server/clipLimits.ts` (≤ 5 min, ≤ 2 min at 1080p) | `{job, state: "queued"\|"running"\|"done"\|"failed", progress, durationS, madeOf?: "clips"\|"stills"\|"mixed", video?: {url, expiresAt, name}}`. Waits up to 25 s; still running, it returns the state |
| `get_clip_job` | `{job}` (a job this token started) | as `generate_clip` |
| `analytics_usage` | `{camera?}` (default: every camera with a proxy) | `{usage: [{camera, enabled, paused: {reason, untilMs} \| null, month: {calls, limit}, today: {calls, cap}, checks: {today, cap}}]}` (the second AI check's budget, `parseUsage`) |

`generate_clip` uses the "Save clip around" path (`at` = start, `preS` 0,
`postS` = end − start) or the event path, both already in
`server/routes/compose.ts`; those two functions move to
`server/proxy/compose.ts` so the route and the tool share them. It never
archives. cam-proxy stops a job nobody polls for 30 s and keeps a result
15 minutes, so cams polls a token's job itself every 10 s until it ends.
At most one MCP job per account is queued or running (the proxy encodes one
at a time with 3 waiting; the Save dialog's users come first); a second
answers `busy`.

## 4. Images

- ffmpeg (already in the image, under the thumbnail semaphore) scales to
  `maxWidth` (never up) and encodes JPEG `-q:v 5`. Cap: 400 KB per image after
  encoding (re-encoded once at `-q:v 10`, else `image_too_large`), 4 images
  and 1.2 MB per tool result.
- Defaults: snapshots 1024 px wide, event images 768, archive thumbnails as
  the proxy has them (small). Claude reads up to 1568 px on the long side.
- No 4K original is ever sent inline; the full picture is a video link away.

## 5. Video links

`GET /mcp/media/<payload>.<sig>`: no bearer header needed, so the person can
open it in a browser or `curl` it.

- `payload`: base64url JSON `{v: 1, tok, acc, cam, kind: "clip"|"composition"|"archive", ref, q?, exp}`.
  `sig`: HMAC-SHA256 with a key derived from `COOKIE_SECRET` (HKDF, info
  `cams mcp media v1`), compared in constant time.
- Expiry: **15 minutes** from issue; a composition's link never outlives the
  proxy's result (15 minutes after it finished).
- On every fetch cams checks the signature and expiry, that the token is still
  live (a revoke kills its links at once), that `acc` is still served, and
  resolves `cam` and `ref` **within `acc`** again (`resolveCamera`,
  `archiveProxy(acc, via)`, cams's own copy of the job id). Then it streams as
  the `/api` routes do: Range passes through, `Content-Disposition:
  attachment`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- 30 fetches a minute per token, counted in the media budget.

## 6. Tokens

**Placement: issued and stored by cams, per instance, on the Settings page
for account admins.** Reasons:
- Account admins sign in to cams, not to cams-admin: cams-admin is the
  sysadmin's control plane and its UI has no account-admin role.
- cams-admin is "not in any data path", and its signed snapshot by design
  never carries a token or hash. Pushing MCP hashes through it would change
  the cams-v1 contract and make every verification depend on a pull that can
  be a minute old, which is too slow for a revoke.
- cams already holds the per-request principal (`authState`), the role table
  and the account isolation; the token just becomes another principal.
- The pattern is cams-admin's `BearerTokens` (shown once, SHA-256 hash,
  live cap, expiry, revoke, last use in memory), copied, not shared.

Lifecycle:
- **Issue:** Settings → card "Assistant access (MCP)", admins only: name
  (1–64 printable characters), days 1–90 (default 30), scope `read` (the only
  choice). The token is `cmcp_` + 32 random bytes base64url, shown **once**
  with Copy and a ready `claude mcp add --transport http cams
  https://cams.skylar.technology/mcp --header "Authorization: Bearer …"` line.
  At most 5 live per account.
- **Stored** in `<data>/mcp-tokens.json` (mode 600 in a 700 folder,
  `checkPrivate` as `admin/tokens.json`, atomic write):
  `{v: 1, tokens: [{id: "mtk_…", accountId, name, hash: "sha256:…", scopes, createdAt, createdBy, expiresAt, revokedAt, revokedBy}]}`.
  `lastUsedAt` and call counts live in memory. The file is re-read when its
  mtime changes (checked at most once a second), so two overlapping Knative
  revisions see a revoke at once.
- **The card** lists name, created by and when, expiry, last use, calls
  today, state; Revoke (confirmed). Viewers don't see the card.
- **Verify** (every `/mcp` request): `Authorization: Bearer cmcp_…` (≤ 128
  characters) → hash → lookup → not revoked or expired → the account is still
  served by this instance → **its issuer is still an admin of that account**
  (`membershipsOf`, as sessions are re-checked) → the scope covers the tool.
  The principal is `{email: "mcp:<id>", via: "mcp", account, role: "viewer"}`.
  Cookies are ignored on `/mcp`.

**Instances.** A token works only on the instance that issued it; each cams
keeps its own file. `/mcp` is off unless `MCP_ENABLED=true`, and cams refuses
to start with it on when `COOKIE_SECURE=false` (plain http would carry the
token in clear). The cluster turns it on. The Pi and the mini PC are LAN
viewers on http today, so they don't offer it (see §11).

## 7. Security

- **Account isolation:** the account comes from the token only. Every camera
  id goes through `resolveCamera(token.accountId, …)`, archive refs through
  `archiveProxy(accountId, via)`, job ids through the token's own job map.
  No input takes an account id, a CamKey or a proxy id; outputs carry camsIds
  only. A test names the same camsId in two accounts.
- **Input validation:** zod schemas per tool, strict objects (unknown keys
  refused), ids by the existing regexes (`CLIP_ID`, `JOB`, camsId), bounded
  strings and arrays, time ranges checked before any I/O. Request body ≤ 64
  KiB; responses ≤ 2 MB.
- **Transport:** stateless Streamable HTTP (`sessionIdGenerator: undefined`,
  JSON responses), so restarts and revisions lose nothing. `POST /mcp` only;
  `GET`/`DELETE` answer 405. A request with an `Origin` other than the public
  origin is refused (DNS rebinding).
- **Rate limits** (in memory, as today: the ksvc is one replica): per token 60
  calls a minute and 2000 a day; images 120 a minute; `generate_clip` 10 an
  hour; failed bearer tokens 10 per 15 minutes per address (as the token
  sign-in); all MCP 300 calls a minute per account.
- **Audit:** one info line per call, `kind: "mcp_call"` with token id,
  account id, tool, camera, time range, outcome code, duration and bytes out
  (info ships to Grafana Cloud); `mcp_token_issue` / `mcp_token_revoke` with
  the hash prefix and the admin's email. Never the token, never image bytes.
  The Authorization header is already redacted by the HTTP logger.
- **A leaked token** reads one account, at most 90 days, within the limits
  above, and can't change anything. Containment: Revoke on Settings (instant;
  its links die too), removing the issuer as admin, the account leaving the
  instance, or `MCP_ENABLED=false`. The logs name every call by token id.
- **Content leaving:** images and links go to the LLM provider of whoever
  holds the token. The Settings card says so in one line.

## 8. Errors

- HTTP (before MCP): 401 `{"error": "unauthorized"}` with `WWW-Authenticate:
  Bearer error="invalid_token"` for a missing, malformed, unknown, revoked or
  expired token (one answer for all); 403 `insufficient_scope`; 404 when
  `/mcp` is off; 405; 413; 429 `rate_limited` with `Retry-After`.
- Tool errors: a result with `isError: true` and `structuredContent: {error,
  message, retryable}`. Codes: `invalid` (with the field), `unknown_camera`,
  `no_proxy`, `camera_offline`, `camera_error`, `proxy_unavailable`,
  `too_old` (proxy release), `not_found`, `range_too_large`, `too_long`,
  `nothing_kept`, `busy`, `image_too_large`, `rate_limited`. Messages are
  short English sentences for the model, never upstream text.
- Media links: 403 `link_invalid` (signature, token, account), 410
  `link_expired`, then the `/api` codes.

## 9. Where it lives

- `server/mcp/`: `router.ts` (mount `/mcp`, `/mcp/media`, before
  `apiRouter`), `auth.ts` (bearer → principal), `tokens.ts` (the store),
  `server.ts` (an `McpServer` per request, tool registration), `tools/*.ts`
  (one file each), `images.ts` (ffmpeg scale), `links.ts` (sign, verify),
  `limits.ts`, `audit.ts`.
- `server/routes/mcpTokens.ts`: `GET/POST /api/mcp-tokens`, `POST
  /api/mcp-tokens/:id/revoke`, three `admin` lines in `server/routes/access.ts`.
- Extracted for sharing: the compose "around"/event start and the archive
  item reader into `server/proxy/`.
- `web/`: the Settings card. README: an "MCP" section; `web/public/llms.txt`
  gets the endpoint.
- Deployment: `MCP_ENABLED=true` on the cluster ksvc is a kube-setup change;
  ask the kube-setup session, after Klaus approves the public endpoint. The
  host and Traefik route are unchanged.

## 10. Tests

- Unit (vitest, cam-sim + `fakeProxy`): token store (issue shows once, hash
  only, file mode, cap, expiry, revoke, re-read on mtime); auth (each refusal
  is the same 401, cookies ignored, issuer demoted or removed, account gone);
  isolation (two accounts with `cam1` each, a token of A never sees B; archive
  refs and job ids of B refused); links (tamper, expiry, revoked token,
  wrong account, Range); each tool through the SDK's client over HTTP against
  the app, outputs validated against their `outputSchema`; image caps;
  rate limits; `generate_clip` keep-alive polling and the `busy` rule;
  `MCP_ENABLED` with `COOKIE_SECURE=false` refuses to start.
- The access-table test already fails on a route without a line.
- e2e: the Settings card (issue, copy line, revoke) on desktop and phone; one
  spec calls `list_cameras` and `get_snapshot` on the e2e stack.

## 11. Decisions for Klaus

1. **The public endpoint:** approve `/mcp` on cams.skylar.technology (then
   kube-setup sets `MCP_ENABLED=true`).
2. **Who issues tokens:** account admins only (proposed), or viewers too,
   each for themselves.
3. **Local viewers:** no `/mcp` on the Pi and the mini PC while they serve
   plain http (proposed), or allow it there on the LAN anyway.
4. **`generate_clip` on the Pi's encoder:** one MCP job per account at a time
   and 10 an hour (proposed); or leave clip generation out of phase 1.
