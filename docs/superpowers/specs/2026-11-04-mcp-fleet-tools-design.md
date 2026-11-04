# Read-only fleet tools in the cams MCP

2026-11-04. Extends `/mcp` (design `2026-10-27-mcp-server-design.md`) with a
view of **one account's** fleet for that account's admins. Decisions marked
"(mine)" are the implementer's calls inside Klaus's approved design; everything
else is his.

## 1. Decisions (Klaus, 2026-11-04)

"We don't want a 'super MCP' that can do everything for every account. The MCP
is intended for an account owner, not the overall system owner. The MCP should
remain read-only." One MCP: the cams viewer's `/mcp`. No MCP server in
cams-admin, no new public endpoint, no new token type.

## 2. Tools

Admin role only, checked per request with the token's person's current role.
Each is annotated read-only and takes `{}`: the account comes from the token.

| Tool | Returns |
|---|---|
| `list_proxies` | `proxies: [{name, displayName, state, version, ok, problemCount, reportedAt, gui: {url, scope, note} \| null, problems: [{id, label, text, camera}], cameras: [{id, name, online}]}]`, `notRouted` |
| `list_viewers` | `viewers: [{name, displayName, thisViewer, address: {url, scope, note} \| null, held: [{camera, fields}], keptOld: [{camera, fields}], heldProxies: [{proxy, fields}], heldTotal}]` |
| `list_moves` | `moves: [{id, camera, cameraName, source, target, phase, reason, bytesTotal, bytesDone, rateBps, etaS, chunks, createdAt, updatedAt, endedAt}]`, newest first, at most 50 |

- `gui`/`address.note` is the sentence from cams-admin's address rule
  (`contract/address.ts`, moved there from `web/src/lib/address.ts`, so the web
  page and this answer use the same code), computed by cams-admin. `scope` is
  `loopback`, `private` or `public`.
- `list_cameras` is unchanged (mine): it already says online, and "which proxy"
  is answered by `list_proxies`' `cameras`, without giving viewer-role tokens
  anything new or making `list_cameras` depend on cams-admin.

## 3. Data path

`GET /cams/v1/accounts/:accountId/fleet` on cams-admin, under the existing
signed service API, so the whole check order of contract cams-v1 applies (mine:
the path; the note suggested `/api/v1/cams/…`, but `/api` is the session and
ops surface and `/cams/v1` is where instance-signed requests live). After the
signature, clock, nonce and instance state: the account must be one this
instance serves, else `403 not_served`, the same answer for an account that
doesn't exist. The answer is signed like every other, and contract fragment
`fleet-response` describes it. Nothing is written (live values come from
memory; no audit row per read: mine, the auth step's own refusals are audited).

cams asks through its `AdminClient`, not through an `/api` route: a new `/api`
route would be a new public endpoint. So these tools are the exception to "one
code path through `/api`", and the role check lives in `server/mcp`:

1. `buildServer` registers the tools only when `principal.role === 'admin'`
   (the server is built per request, so `tools/list` hides them from a viewer
   and a call gets the SDK's "tool not found");
2. the tool checks the role again (`forbidden`).

The account is always `principal.account.id`; no tool has an account input.

## 4. What cams keeps

Nothing beyond the call, except one in-memory entry per account for 5 seconds,
dropped by a timer. Concurrent calls share a request.

Fleet requests share the instance's 60 requests a minute at cams-admin with its
config pull and report, while MCP allows far more calls. So cams sends at most
20 fleet requests a minute (mine), above that `rate_limited`, and a heavy
assistant can't starve the config pull.

cams rebuilds each tool's answer through a zod schema that names every field:
a field cams-admin adds later never reaches an assistant by accident.

## 5. Isolation

Enforced at cams-admin (cams can't be relied on to ask for the right account
and could be the compromised party):

- served-account check on every request, from the database;
- proxies, cameras, moves by `account_id` of the requested account;
- a viewer serving several accounts: only rows of its report whose `accountId`
  is this one; no account list, no other account's anything; not even totals
  (`heldTotal` counts this account's);
- fields named one by one; never spread from a row.

**Left out, and tested:** other accounts, tokens, keys, CA fingerprints, camera
passwords, cams-admin's audit log; also internal ids (`prx_`, `cam_`, `cms_`,
`key_`) except the move id, and `detail` of a move (free text; `reason` is the
code) (mine).

**Routes (mine; Klaus may want to widen it):** `list_proxies` lists only the
account's proxies routed to this viewer and not hidden, the snapshot's
default-deny rule, plus `notRouted`, the number of the account's other proxies,
so an assistant can say "there are more; ask the admin console". Moves and held
changes still name such a proxy by its display name: it is this account's own,
and without its address.

Only `enrolled` viewers are listed (mine); a pending one serves nobody yet.

## 6. Errors (`{error, message, retryable}`)

| Case | Code | Retryable |
|---|---|---|
| cams-admin unreachable, unsigned or unreadable answer, 5xx, key trouble | `admin_unavailable` ("cams-admin can't be reached") | yes |
| 404 from an older cams-admin; a viewer not enrolled (file mode) | `not_available` | no |
| 403 (`not_served`, `revoked`) | `forbidden` | no |
| 429, or cams's own 20 a minute | `rate_limited` | yes |

All other tools keep working: they never touch this client.

## 7. Limits of the answer

≤ 1 MiB as the contract requires: ≤ 64 proxies, 20 problems each (`id` ≤ 64,
`label` ≤ 120, `text` ≤ 240 characters), 256 cameras; ≤ 32 viewers, 50 entries
each in `held`, `keptOld`, `heldProxies` (`heldTotal` says the full number); 50
moves.

## 8. Release

cams-admin first, then cams. cams against an older cams-admin answers
`not_available`. While both PRs are open, cams vendors the contract from the
cams-admin branch (`SOURCE`, the drift check follows it); after the cams-admin
merge the branch is gone, so re-vendor from `main` before merging cams.

## 9. Where to use it

The tools are for the cluster viewer's `/mcp`: it serves every account and is
reachable by its address. A Pi or mini PC viewer has them too, with what that
viewer is routed.

## 10. Tests

cams-admin `test/cams-fleet.test.ts`: instance A can't read account B, unknown
account same 403; blocked and revoked instance; unsigned and wrongly signed;
JSON scan for markers, fingerprints, tokens and other accounts; multi-account
viewer; hidden route; schema. Contract: `fleet-response`, fixtures, one request
vector.

cams `test/mcp/fleetTools.test.ts` over the SDK client and the fake cams-admin:
viewer-role token sees and can use none; demoted at once; removed member's token
401; each tool's fields; unknown fields dropped; unreachable, older, refused;
other tools keep working with cams-admin down; cache and cap; every tool
read-only.
