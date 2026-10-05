# The Archive in cams

2026-10-05. The cams half of the Archive: clips kept on the camera's cam-proxy
apart from normal retention. The feature, its data model and the proxy's
rulings are cam-proxy's
[archive design](https://github.com/klaushofrichter/cam-proxy/blob/main/docs/superpowers/specs/2026-10-05-archive-design.md)
(PR "Archive: clips kept apart from retention (proxy)"). cams builds against its binding API
contract (cam-proxy `docs/archive.md`, "API"): create (`POST
/api/cameras/{cam}/archive`, archive jobs), list, one item (GET, PATCH,
DELETE, video with Range, thumbnail, metadata), bulk delete, ZIP, status,
and the stream type `archive`. Klaus approved the feature and its defaults;
the open points were decided while he was away, each as a ruling (§4).

## 1. What the user sees

**Save dialog → Archive.** Next to Save, whenever Save is possible and the
camera has a cam-proxy in use: at once for a plain SD or 4K save, after
Generate for a composed clip (rolls, sizes, "around this second"). It turns
the dialog into **Archive clip**:

- a line saying where it goes ("Keeps this clip on Den's cam-proxy, apart
  from the normal retention");
- **Name**, prefilled "YYYY-MM-DD HH:MM:SS Den" (the clip's first second),
  editable, 1 to 120 characters;
- **Retention**: days (365) or **Forever**;
- **Labels**: the predefined Pet, Person, Vehicle, SD, 4K as toggles,
  preselected from the card's kinds (person, vehicle, pet) and the size (SD
  or 4K); custom one-word labels added in a field (Enter or Add), removed by
  ✕; the rules said in words ("A label is one word: letters and digits only.");
- **Archive** → "Starting…" → (a longer job) a progress bar with the phase
  and the bytes ("Fetching the recording from the camera… 25.0 MB of 100.0
  MB") and "Cancel archiving" → **done** ("Archived as "Fox at the door"
  (4.1 MB).") with **Open in Archive** and Close;
- errors in words, sizes included: "Not enough space on the cam-proxy: the
  clip needs 4.0 GB, 5.0 GB is free, and 2.1 GB must stay free.", the
  Archive switched off, camera offline, busy, rate limited, a composed clip
  gone, a recording gone, a failed job by its reason. The form stays, to try
  again or Cancel;
- **Cancel** goes back to the Save dialog with its result.

**The Archive page** (`/app/archive`, menu entry "Archive" when a camera has
a cam-proxy): one list over every cam-proxy's archive.

- A summary: "37 clips · 912.3 MB" and per proxy "0.4 % of the disk, 98.0 GB
  free" (red with "over the warning level" past the proxy's `warnPercent`);
  a proxy that answered nothing or has no Archive yet is named.
- Filters: text (name, camera, labels), camera, label chips (all chosen
  labels; the predefined five, then the others by use).
- Desktop: a table with a small thumbnail (▶ opens the player), Name,
  Recorded, Camera, Duration, Quality, Size, Labels, Expires ("in 120 days",
  "today", "forever"), Archived, and an Edit button. Every column sorts (a
  click, again for the other direction; `aria-sort`). Phone: cards, a sort
  menu, "Select all".
- Selection: a box per row, shift-click for a range (the rows shown), the
  header box for all shown (indeterminate for some). A bar (sticky on
  desktop, fixed at the bottom on a phone) with **Delete** (a confirmation
  naming the count: "Delete 3 clips?"), **Download ZIP**, **Set labels**,
  **Set retention**, **Edit** (one) and Clear.
- **Recorded** links to the Video page at that second (`/app/video?cam&date&at`)
  while the camera still holds the recording (its oldest content, `/extent`);
  otherwise plain text whose tooltip says the camera no longer holds it.
- **Player** (thumbnail click): the video through cams's relay (ranges),
  ▶/❚❚, −10 s, −1 s, +1 s, +10 s, a mini timeline to seek ("0:01 / 0:30"; ← →
  and Space on the video), and the metadata: recorded window, camera,
  duration, quality (original or not), size, source ("Composed: SD, pre-roll
  0 s, post-roll 10 s, still sections marked"), labels, archived, expires,
  the window's events with Vision's findings and objects, the still checks;
  **Download** (one clip, the proxy's file name) and **Edit**.
- **Edit** (one): name, labels, retention. **Set labels** (many): each chip
  is on for all, for some (dashed: each clip keeps its own) or for none; a
  click makes it all or none. **Set retention** (many): days or forever.
- Live: a relayed `archive` message reloads the list; without the event
  stream the page reloads every minute.
- "Open in Archive" opens the page with `?item=<via>:<id>`: that row is
  outlined and scrolled into view.

## 2. cams's server

`server/routes/archive.ts`, all behind the sign-in and the same-origin check
of `/api`, relayed with the camera's cam-proxy client token (server-side
only; no proxy URL or token in any answer):

| cams | cam-proxy |
|---|---|
| `POST /api/cameras/:id/archive` `{source: {type: "composition", id} \| {type: "event", eventId, quality: "sub"\|"main"}, name?, labels?, retentionDays?, thumbnailAt?}` | `POST /api/cameras/{cam}/archive` |
| `GET\|DELETE /api/archive/:via/jobs/:job` | `GET\|DELETE /api/archive/jobs/{id}` |
| `GET /api/archive?sort&order&cam&labels&q&quality&from&to` | `GET /api/archive` of every proxy, all pages, merged |
| `GET /api/archive/status` | `GET /api/archive/status` of every proxy |
| `GET\|PATCH\|DELETE /api/archive/:via/items/:id` | `GET\|PATCH\|DELETE /api/archive/{id}` |
| `GET /api/archive/:via/items/:id/video[?download=1]`, `/thumbnail`, `/metadata` | `…/{id}/video`, `/thumbnail`, `/metadata` |
| `POST /api/archive/:via/delete {ids}` | `POST /api/archive/delete` |
| `GET /api/archive/:via/zip?ids=` | `GET /api/archive/zip?ids=` |

- **`via`**: a proxy is reached through the first cams camera that uses it
  (one per proxy URL and token); items are `via:id`. A switched-off proxy is
  left out. An older proxy (404 on `/api/archive`) is `too_old`.
- **Checks before the proxy**: the name, labels and retention by the
  contract's rules (`server/archiveRules.ts`, also used by the web app and
  the fake proxy); a composition only by cams's own record of the jobs it
  started for that camera; an event by the camera's day list (the SD file
  the download would serve: `RecordingsService.archiveSource`); ids as
  integers (1 to 500 for a bulk delete, 1 to 200 for a ZIP); job ids only
  from cams's record of the jobs it started. No request value becomes a
  proxy path.
- **Answers rebuilt** from checked fields (`server/proxy/archive.ts`):
  items, jobs, status, metadata (Vision's objects: name, score, box only).
  The proxy's refusals pass with their status (400, 404, 409, 429, 503, 507)
  and only the contract's fields (`needed`, `free`, `minFreeBytes`, `state`,
  `missing`, `detail`); a create whose job failed within the proxy's 3 s
  passes with the job's status (500 `store_failed` and 502 `fetch_failed`
  included) and code; anything else is 502 `proxy_unavailable`.
- **Streams**: video (Range passed, 206/416, `Content-Range`, `ETag`) and
  ZIP (`Content-Length`, the proxy's `Content-Disposition` when it matches
  the contract's form) are piped as they arrive, never buffered; a viewer
  who leaves cancels the upstream request. Video and thumbnails are
  `private, max-age=604800, immutable` (ids are never reused).
- **Who**: `X-On-Behalf-Of: <the signed-in email>` on every write (create,
  PATCH, DELETE, bulk delete, job cancel).
- **Limits**: per signed-in user 10 new clips and 4 ZIPs a minute
  (`RATE_LIMIT_ARCHIVE_PER_MIN`, `RATE_LIMIT_ARCHIVE_ZIP_PER_MIN`); video and
  thumbnails count as clip media (`RATE_LIMIT_MEDIA_MAX`), the rest as API.
- **SSE**: the proxy stream asks for `archive` too (dropped for an older
  proxy that refuses it); the browser relay sends `event: archive` with
  `{cam, action, ids}` only.

## 3. Tests

Unit (`test/archiveRules.test.ts`, `web/src/lib/archive.test.ts`): name,
labels (spelling, set, limits, preselection), retention, the sort keys and
ties of the contract, the default name, expiry words, sizes, refusals in
words, filters, selection (shift ranges, header), bulk labels, per-proxy
delete and ZIP lists, the Video link. Relay (`test/archiveRoutes.test.ts`):
auth and same origin, create (composition, recording, refusals, 507 with
sizes, 202 + poll + cancel), list merge of two proxies and an older one,
filters and paging, status, PATCH/DELETE/bulk, video ranges and download
name, thumbnail, metadata rebuilt, ZIP streamed before the proxy finished,
rate limits; `test/recordingsViaProxyDownloads.test.ts` for the plain save's
file; `test/proxyStream.test.ts` for the SSE relay. Components: the archive
step's states, the Save dialog's Archive button, the page (list, sort,
filters, link, selection, delete with confirmation, ZIP per proxy, edit one,
set labels on many, player, live reload, phone cards). e2e
(`e2e/archive.spec.ts`, desktop and phone): archive a composed clip from
Save → Open in Archive → play → edit labels → ZIP holds mp4, json and jpg →
delete with confirmation; a plain SD save twice → shift range → set
retention forever → delete both; the menu entry, and no Archive button
without a proxy. The fake proxy (`test/proxy/fakeArchive.ts`) implements the
contract.

## 4. Rulings

1. Ruling: one PR for the Archive button and the page — "Open in Archive"
   needs the page, and both use the same relay and rules — cost if wrong: a
   bigger review.
2. Ruling: the archive step replaces the Save dialog's body in the same
   modal; Cancel brings the Save dialog back as it was — no nested modal
   and focus trap, and the composed result stays alive (the dialog keeps
   polling it) — cost: none; a nested modal would be a small change.
3. Ruling: the name field starts with the contract's default in the
   viewer's clock and is sent only when edited, so an untouched name is the
   proxy's, in the camera's clock (cam-proxy ruling 9) — cost: with the
   browser in another zone than the camera, an untouched name differs from
   what the field showed by the zones' offset (editable later).
4. Ruling: Download ZIP makes one ZIP per proxy (and per 200 clips),
   started one after another — each is the proxy's own streamed ZIP,
   relayed unbuffered; a merged ZIP would mean writing ZIP64 and CRCs in
   cams — cost: a selection across proxies gives two files, and a browser
   may ask once to allow several downloads.
5. Ruling: a proxy is addressed by `via`, the first cams camera that uses it
   (by URL and token) — ids are per proxy, and a proxy shared by two cameras
   is listed once — cost: reordering the cameras file changes `via`, so an
   old `?item=` link no longer highlights its row.
6. Ruling: sorting asks the proxies in that order (`sort`, `order`) and
   merges with the contract's comparator (`server/archiveRules.ts`); the
   page reorders at once by the same rule while it asks — all nine keys are
   in the contract — cost: one list request per sort click.
7. Ruling: the filters (labels, camera, text) work in the browser over the
   whole merged list (each proxy paged to 10 000 clips) — instant, and
   kept across live reloads; the text also matches camera and labels — cost:
   past 10 000 clips per proxy the oldest (in the chosen order) are missing.
8. Ruling: the relayed `archive` message carries only the action and the
   ids; the page reloads the list (300 ms debounce) — items are rebuilt by
   the relay, never passed raw — cost: one list request per change.
9. Ruling: a plain SD or 4K save archives the SD card's file the download
   would serve (`source.type` `recording`, by the bare name from the
   camera's day list); SD while the proxy's recordings fail takes the
   proxy's FTP copy (`clip`), like the download; 4K never falls back (409
   `full_quality_unavailable`) — the clip is what Save gives — cost: an FTP
   copy of the main stream (the Pi's) is stored as the proxy labels it
   (4K), though SD was picked.
10. Ruling: `thumbnailAt` is sent for "Save clip around this" (its second);
    for an event card none, and the proxy applies #157's rule itself (its
    spec §2.5, step 2: the same rule) — cams has only the card's version
    string, not the second — cost: should the two rules drift apart, the
    archived thumbnail differs from the card's.
11. Ruling: Archive shows only for a camera with a cam-proxy in use, and is
    enabled exactly when Save is (and 4K's file is available) — cost: none.
12. Ruling: closing the dialog doesn't cancel a running archive job; only
    "Cancel archiving" does — the contract runs jobs without polling, so a
    closed tab loses nothing — cost: a clip the user walked away from is
    archived anyway (delete it).
13. Ruling: per signed-in user, 10 new clips and 4 ZIPs a minute (the
    proxy's per-client numbers, as cams is one client to it) — one person
    can't use up everyone's budget — cost: a 429 from cams before the
    proxy's.
14. Ruling: `X-On-Behalf-Of` is the session's email on every write, job
    cancels included; left out when it isn't 1–254 printable ASCII — the
    proxy audits who — cost: none.
15. Ruling: "Set labels" on many uses three-state chips (all, some, none),
    a mixed chip keeps each clip's own; one PATCH per clip, four at a time
    (the contract has no bulk PATCH) — cost: N requests for N clips.
16. Ruling: the recorded time links to the Video page when it is at or after
    the camera's oldest content (`/extent`), else plain text with a tooltip —
    cost: a gap inside the kept days (a card swapped) still links.
17. Ruling: delete is a bulk action (select one or many) with a confirmation
    naming the count; rows have no one-click delete — cost: two clicks to
    delete one.
18. Ruling: a switched-off cam-proxy's archive is left out of the list, and
    an older one (no Archive) is named as such — the switch means "ignore
    the proxy" — cost: its clips are hidden while it is off.
19. Ruling: the player has its own controls over a plain `<video>` (no
    browser controls), so ±1/±10 s and the timeline work the same everywhere;
    Download is the proxy's `?download=1` name when it matches the contract,
    else `archive-<id>.mp4` — cost: no browser volume or fullscreen buttons
    (the video's own keys still work).
20. Ruling: video and thumbnails are relayed `private, max-age=604800,
    immutable`, not `/api`'s no-store — ids are never reused (contract §0) —
    cost: none.
