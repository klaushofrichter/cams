# MCP server in cams

2026-10-27. An MCP endpoint at `https://cams.skylar.technology/mcp` that gives
an LLM (Claude Code, Claude Desktop, any MCP client) read access to **one
account's** cameras and content, with a personal bearer token. Klaus
approved the concept ("Can we offer an MCP for an account … protected by a
token for a specific account?"; "The read-only tools should also give access
to content, like thumbnails, archive and possibly generate clips") and, the
same day, the public endpoint and the decisions in §11. kube-setup is to be
informed before it is switched on in the cluster (§9).

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
  new), with `zod` pinned to **4.6.7** (2026-10-12).
- One token, one person, one account, explicit scopes. Phase 1 has the single
  scope `read`.
- **One code path to the content.** A tool calls cams's own `/api` routes
  in-process over loopback, as the token's principal (§6, "Internal calls").
  The role table, the account isolation, the validation and every route's
  proxy and camera handling apply unchanged; the MCP layer only shapes inputs
  and outputs.
- Images as MCP image content, scaled down. Videos only as signed links.

Non-goals (phase 1):
- Writes. **Phase 2** may add a `write` scope with `archive_clip` and
  `save_clip_around` (archive the result); still checks (they spend the
  Vision budget) would go there too. Camera settings, the light, reboot,
  rename, the proxy switch and anything else that changes a camera or proxy
  stay out for good.
- OAuth 2.1 for claude.ai custom connectors: a later phase (the SDK has the
  pieces; the bearer token stays for CLI clients).
- Live video, the event stream as MCP notifications, MCP resources and
  prompts. Tools only.

## 3. Tools

Common rules. `camera` is the account's camera id (`cam1`), as on `/api`.
Times in are ISO 8601 with an offset, or unix ms; times out are both
(`startMs` plus `start` as `/api` gives it). Every tool returns
`structuredContent` (the JSON below, declared as its `outputSchema`) plus the
same JSON as one text block for older clients. Images are extra `image`
blocks. Lists are capped and say `truncated: true`. Every tool is annotated
`readOnlyHint: true` except `generate_clip` (it makes a temporary file).

| Tool | Input | Output (structuredContent) |
|---|---|---|
| `list_cameras` | `{}` | `{cameras: [{id, name, online: bool \| null, model: string \| null, simulated: bool, hasProxy: bool, lastEvent: {id, startMs, kinds[]} \| null}]}` (`lastEvent` from the last two days' lists) |
| `get_snapshot` | `{camera, maxWidth?: 320–1568 = 1024}` | `{camera, takenAtMs, source: "proxy-still" \| "camera", width, bytes}` + 1 image. The proxy's newest still when it is at most 5 s old, else the camera's snapshot |
| `list_events` | `{camera, from, to, kinds?: ("person"\|"vehicle"\|"pet"\|"motion"\|"timer")[], limit?: 1–200 = 100}`; `to − from` ≤ 7 days | `{camera, events: [Event], truncated}` with `Event = {id, startMs, endMs, start, end, durationS, kinds[], counts: {person?, vehicle?, pet?}, vision: {best: {kind: score}, notConfirmed: kind[]} \| null}`; `id` is the clip id `YYYYMMDD-HHMMSS-HHMMSS` |
| `get_event` | `{camera, eventId, images?: 0–4 = 1, maxWidth?: 320–1568 = 768}` | `{event: Event, stills: [{ts, kind, objects: [{category, subtype, score}]}], video: Link}` + the card's thumbnail and then analysed stills, up to `images` |
| `search_recordings` | `{from, to, cameras?: id[], kinds?, visionConfirmed?: bool, minDurationS?, limit?: 1–200 = 50}`; range ≤ 31 days | `{hits: [{camera, id, startMs, durationS, kinds[], visionConfirmed: kind[]}], daysSearched, truncated}`, newest first. Reads each month's `days` first, so days without recordings cost nothing |
| `list_archive` | `{q?, labels?: string[], camera?, from?, to?, sort?: "recorded"\|"created" = "recorded", order?: "asc"\|"desc" = "desc", limit?: 1–100 = 50}` | `{items: [ArchiveItem], unavailable: [{via, error}], truncated}` with `ArchiveItem = {ref: "<via>:<id>", name, camera, cameraName, recordedFromMs, recordedToMs, durationS, quality, bytes, labels, expiresAtMs \| null}` |
| `get_archive_clip` | `{ref, thumbnail?: bool = true}` | `{item: ArchiveItem & {eventKinds}, video: Link}` + the thumbnail |
| `generate_clip` | `{camera, start, end, size?: "sd"\|"360p"\|"720p"\|"1080p" = "sd", badge?: bool = true}` or `{camera, eventId, preS?: = 0, postS?: = 0, size?, badge?}`; the length rules of `server/clipLimits.ts` (≤ 5 min, ≤ 2 min at 1080p) | `ClipJob = {job, state: "queued"\|"running"\|"done"\|"failed"\|"cancelled", progress, durationS \| null, error \| null, video: Link \| null}`. Waits up to 25 s; still running, it returns the state |
| `get_clip_job` | `{job}` (a job this token started) | `ClipJob` |
| `analytics_usage` | `{camera?}` (default: every camera with a proxy) | `{usage: [{camera, enabled, paused: {reason, untilMs} \| null, month: {calls, limit}, today: {calls, cap}, checks: {today, cap}} \| {camera, error}]}` (the second AI check's budget) |

`Link = {url, expiresAtMs}`.

`generate_clip` posts to `/api/cameras/:id/compositions` ("Save clip around"
with `at` = start, `preS` 0, `postS` = end − start; or the event path). It
never archives. cam-proxy stops a job nobody polls for 30 s and keeps a
result 15 minutes, so cams polls a token's job itself every 10 s until it
ends (at most 10 minutes). **At most one MCP job per account is queued or
running, and 10 per account an hour** (§11): the proxy encodes one at a time
with 3 waiting, and the Save dialog's users come first. A second answers
`busy`, the eleventh `rate_limited`.

## 4. Images

- ffmpeg (already in the image; two at a time, as the thumbnails) scales to
  `maxWidth` (never up) and encodes JPEG `-q:v 5`. Cap: 400 KB per image
  (re-encoded once at `-q:v 12`, else `image_too_large`), 4 images and
  1.2 MB per tool result.
- Defaults: snapshots 1024 px wide, event images 768, archive thumbnails as
  the proxy has them, scaled to at most 768. Claude reads up to 1568 px on
  the long side.
- No 4K original is ever sent inline; the full picture is a video link away.

## 5. Video links

`GET /mcp/media/<payload>.<sig>`: no bearer header needed, so the person can
open it in a browser or `curl` it.

- `payload`: base64url JSON `{v: 1, tok, acc, cam, kind: "clip"|"composition"|"archive", ref, exp}`.
  `sig`: base64url HMAC-SHA256 with a key derived from `COOKIE_SECRET` (HKDF,
  info `cams mcp media v1`), compared in constant time.
- Expiry: **15 minutes** from issue; a composition's link never outlives the
  proxy's result (15 minutes after it finished).
- On every fetch cams checks the signature and expiry, that the token is still
  live (a revoke kills its links at once) with an issuer who is still a
  member of `acc`, and then fetches through the internal `/api` call as that
  principal, so `cam` and `ref` are resolved within the account again. It
  streams as the `/api` routes do: Range passes through, `Content-Disposition:
  attachment`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- 30 fetches a minute per token.

## 6. Tokens

**Placement: issued and stored by cams, per instance, on the Settings page.**
Reasons:
- People sign in to cams, not to cams-admin: cams-admin is the sysadmin's
  control plane and its UI has no account roles.
- cams-admin is "not in any data path", and its signed snapshot by design
  never carries a token or hash. Pushing MCP hashes through it would change
  the cams-v1 contract and make a revoke wait for the next pull.
- cams already re-checks the person and role on every request and isolates
  accounts; a token becomes another way to be that person.
- The pattern is cams-admin's `BearerTokens` (shown once, SHA-256 hash, live
  cap, expiry, revoke, last use in memory), copied, not shared.

**Who** (§11): every signed-in member issues tokens **for themselves**. A token
acts with its issuer's current role and membership in its account, re-checked
on every request: an issuer removed from the account (or disabled) makes the
token dead, a role change applies at once. For a token-login issuer (the Pi
demo kit) the token stays valid while that login stays configured with the
same token user and token, as its sessions do.

Lifecycle:
- **Issue:** Settings → card "Assistant access (MCP)": name (1–64 printable
  characters), days 1–90 (default 30), scope `read` (the only choice). The
  token is `cmcp_` + 32 random bytes base64url, shown **once** with Copy and a
  ready `claude mcp add --transport http cams <origin>/mcp --header
  "Authorization: Bearer …"` line. **Caps: 3 live tokens per person per
  account, 20 per account** (409 `too_many_tokens`).
- **Stored** in `<data>/mcp/tokens.json` (`MCP_TOKENS_FILE` overrides; mode
  600 in a 700 folder, checked as `admin/tokens.json`, atomic write):
  `{v: 1, tokens: [{id: "mtk_…", accountId, name, hash: "sha256:…", scopes, issuer: {email, via, tf?}, createdAt, expiresAt, revokedAt, revokedBy}]}`.
  `lastUsedAt` and call counts live in memory. The file is re-read when its
  mtime changes (checked at most once a second), so two overlapping Knative
  revisions see a revoke at once. Expired and revoked entries are dropped 30
  days later.
- **The card**: "Your tokens" (name, created, expiry, last use, calls today,
  state, Revoke) for everyone; account admins also get "All tokens of this
  account" with the issuer. Never the secret or the hash. Revoke is
  confirmed; a member revokes only their own, an admin any of the account.
- **API** (`/api/mcp-tokens`, same-origin, session only, never a token's
  internal call): `GET` (own; `?all=1` for admins), `POST` `{name, days}` →
  201 `{token, item}`, `POST /:tokenId/revoke`.
- **Verify** (every `/mcp` request): `Authorization: Bearer cmcp_…` (≤ 128
  characters) → hash → lookup → not revoked or expired → the issuer's current
  principal in that account (`principalIn`, the function sessions use) → the
  scope covers the tool. Cookies are ignored on `/mcp`.

**Internal calls.** A tool calls `/api` over loopback (`127.0.0.1` or the
address the request came in on, the same port) with two headers:
`X-Cams-Internal` (32 random bytes made at process start, never logged or
sent elsewhere, compared in constant time) and `X-Cams-Mcp-Token` (the token
id). `requireAuthApi` takes such a request's principal from the token store
(the same verification) and nothing else, never its cookie; a wrong secret is
401. Internal calls skip the per-address `/api` limits (the MCP limits apply)
and may not reach `/api/mcp-tokens`.

**Instances** (§11). A token works only on the instance that issued it; each
cams keeps its own file. `/mcp` is off unless `MCP_ENABLED=true`. With
`COOKIE_SECURE=false` (plain http, the Pi and the mini PC on the LAN) it also
needs `MCP_ALLOW_HTTP=true`; without it such a viewer doesn't serve `/mcp`
(404) and logs `mcp_http_refused` once at start. With it, the Settings card
says "This viewer runs over plain http: tokens and video links travel
unencrypted on your network."

## 7. Security

- **Account isolation:** the account comes from the token only, and every
  content request runs through `/api` as its principal. No input takes an
  account id, a CamKey or a proxy id; outputs carry camsIds only. A test
  names the same camsId in two accounts.
- **Input validation:** zod schemas per tool, strict objects (unknown keys
  refused), ids by the existing patterns (clip id, job id, camsId, archive
  ref `<camsId>:<digits>`), bounded strings and arrays, time ranges checked
  before any I/O. Request body ≤ 64 KiB.
- **Transport:** stateless Streamable HTTP (`sessionIdGenerator: undefined`,
  JSON responses), so restarts and revisions lose nothing. `POST /mcp` only;
  `GET`/`DELETE` answer 405. A request with an `Origin` other than the
  server's own is refused 403 (DNS rebinding).
- **Rate limits** (in memory, as today: the ksvc is one replica): per token
  60 calls a minute and 2000 a day; per account 300 calls a minute;
  `generate_clip` as §3; media links 30 a minute per token; failed bearer
  tokens 10 per 15 minutes per address.
- **Audit:** one info line per call, `kind: "mcp_call"` with token id,
  account id, tool, camera, outcome code, duration and image bytes (info
  ships to Grafana Cloud); `mcp_token_issue` / `mcp_token_revoke` with the
  hash prefix, the issuer and who revoked. Never the token, never the
  internal secret, never image bytes.
- **A leaked token** reads one account as its issuer could, at most 90 days,
  within the limits above, and can't change anything but start a temporary
  clip. Containment: Revoke on Settings (instant; its links die too),
  removing the issuer from the account, the account leaving the instance, or
  `MCP_ENABLED=false`. The logs name every call by token id.
- **Content leaving:** images and links go to the LLM provider of whoever
  holds the token. The Settings card says so in one line.

## 8. Errors

- HTTP (before MCP): 401 `{"error": "unauthorized"}` with `WWW-Authenticate:
  Bearer error="invalid_token"` for a missing, malformed, unknown, revoked or
  expired token (one answer for all); 404 when `/mcp` is off; 403
  `cross-origin request rejected`; 405; 413; 429 `rate_limited` with
  `Retry-After`.
- Tool errors: a result with `isError: true` and `structuredContent: {error,
  message, retryable}`. Codes: `invalid`, `unknown_camera`, `no_proxy`,
  `camera_offline`, `camera_error`, `proxy_unavailable`, `too_old`,
  `not_found`, `range_too_large`, `too_long`, `nothing_kept`, `busy`,
  `image_too_large`, `rate_limited`, `forbidden`. Messages are short English
  sentences for the model, never upstream text.
- Media links: 403 `link_invalid` (signature, token, account), 410
  `link_expired`, then the `/api` codes.

## 9. Where it lives

- `server/mcp/`: `config.ts` (enabled, http opt-in), `tokens.ts` (the
  store), `internal.ts` (the secret, the loopback caller), `auth.ts` (bearer
  → principal), `limits.ts`, `links.ts` (sign, verify), `images.ts` (ffmpeg
  scale), `tools/*.ts`, `server.ts` (an `McpServer` per request), `router.ts`
  (`/mcp`, `/mcp/media`).
- `server/middleware/requireAuth.ts`: `principalIn` shared with the token
  check; the internal principal in `requireAuthApi`.
- `server/routes/mcpTokens.ts` and three lines in `server/routes/access.ts`.
- `web/`: the Settings card. README: a section "MCP server";
  `web/public/llms.txt` gets the endpoint; CHANGELOG.
- **Deployment:** `MCP_ENABLED=true` on the cluster ksvc is a kube-setup
  change (ask the kube-setup session). The host, Traefik route and the data
  volume (`/var/lib/cams`, already mounted for `PREFS_FILE`) are unchanged.

## 10. Tests

- Unit (vitest, cam-sim + `fakeProxy`): token store (shown once, hash only,
  file mode, caps per person and account, expiry, revoke, re-read on mtime);
  verification (one 401 for every refusal, cookies ignored, issuer removed,
  disabled or demoted, token-login issuer); internal calls (wrong secret 401,
  no cookie fallback, `/api/mcp-tokens` refused); isolation (two accounts with
  `cam1` each); links (tamper, expiry, revoked token, Range); each tool
  through the SDK's client over HTTP against the app; image caps; limits;
  `generate_clip` keep-alive and `busy`; `/mcp` off, and the http opt-in.
- The access-table test already fails on a route without a line; the
  isolation source scan also covers `server/mcp/`.
- e2e: the Settings card (issue, copy line, revoke) at both sizes; one spec
  uses the SDK's client against the e2e server: lists the tools, calls
  `list_cameras` and `get_snapshot`.

## 11. Decisions (Klaus, 2026-10-27)

1. **The public endpoint:** approved. kube-setup sets `MCP_ENABLED=true` on
   the cluster ksvc.
2. **Who issues tokens:** "Viewers too, for themselves." Every member issues
   their own read tokens; a token acts with its issuer's role and membership,
   re-checked on every request; members see and revoke their own, account
   admins see all of the account's (never the secret) and revoke any. Caps 3
   per person, 20 per account.
3. **Local viewers:** "Allow on the LAN." Opt-in on the Pi and the mini PC
   with `MCP_ALLOW_HTTP=true` next to `MCP_ENABLED=true`; the Settings card
   warns that tokens travel unencrypted there; without the opt-in a plain
   http viewer doesn't serve `/mcp`.
4. **`generate_clip`:** one job at a time per account, 10 an hour, as
   proposed.
