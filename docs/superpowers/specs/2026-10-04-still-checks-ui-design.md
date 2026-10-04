# Still checks on the Timeline (cams #179, phase 2)

2026-10-04. The cams half of "still checks": Vision on any second, picked by
hand on the Timeline. The design of the whole feature, its data model and the
proxy's rulings are cam-proxy's
[still checks design](https://github.com/klaushofrichter/cam-proxy/blob/main/docs/superpowers/specs/2026-10-04-still-checks-design.md)
(cam-proxy PR #143, phase 1). This spec builds against that PR's API contract
(`POST/GET /api/cameras/{cam}/still-checks`, `GET …/{id}`, `…/{id}.jpg`,
`GET /api/cameras/{cam}/analytics`, stream type `still-check`) and records
what cams decides on its own. Phase 3 ("Save clip around this") and phase 4
(the Video page's Checks mode) are not here.

## 1. What the user sees

On the Timeline, under the large still (the bar with ◀ 1 s ▶):

- **"✧ Check with Vision"**, with a usage line beside it: "14 of 1000 this
  month · 2 of 10 checks today" (from `GET …/analytics`). Over 1000 calls a
  month the line adds the price ("about $0.0023 a check beyond 1000 a
  month").
- **Disabled, with the reason** in its title and in the line under it, from
  `GET …/analytics`: Vision off / no key ("Vision is off for this camera"),
  paused ("Vision is paused (invalid key)", "Vision is paused (quota) until
  14:00"), checks off (`checks.cap` 0), the monthly limit, the daily cap,
  today's checks used; and from the page: a second without a still ("No
  still for this second"), a check running ("Checking…"), an older proxy
  (`analytics` 404: "This camera gateway is too old for checks").
- **Pressed:** a spinner and "Checking…"; then the result **in place**: the
  boxes on the still (`TimelineStill` with the summary and #158's object
  list: Boxes / Plain still, "Show all objects", a click shows one box), a
  line "Vision: Person 84%, Dog 61%" or "Vision: nothing relevant", and for a
  confirmed event "Confirms the Person event".
- **A checked second** shows its result at once (the check's own JPEG, so it
  is the image Vision saw, also after the 7-day stills are gone); the button
  then reads "✧ Checked 14:03:22" and is disabled.
- **A reused answer** says so: "Checked before, no new call" (`source:
  check`), "Analysed before with its event, no new call" (`source: event`).
- **Errors** in words, under the button: budget (month, day, checks), busy,
  rate limited, paused (with when it lifts), `provider_failed` by reason
  (timeout, network, aborted, bad key, quota, other), too old, no still,
  gateway unreachable.

Marks:

- **Seconds:** ✧ (hollow) on a checked second; ✦ (the automatic analysis'
  mark) wins when a second has both.
- **Minute tiles:** a dotted purple corner on a minute with a check (any
  result); the solid purple edge stays the automatic "Vision found
  something".
- The legend line names both.

The day's list:

- A **"✧ Checks (n)"** chip in the Timeline's header. Pressed, the day's
  checks above the hour grid: time, findings ("Person 84%" or "nothing
  relevant"), the linked event ("in a Person event", "outside any event"). A
  row opens that second (its minute view and large still).
- **◀ ✧ / ✧ ▶** in the large still's bar: the previous / next check of the
  day (disabled at the ends); **Shift+← / Shift+→** the same.

Live: a check made in another tab (or the proxy's admin UI) appears without a
reload: the marks, the list, the chip's count, the open still's result and the
usage line.

Cards (Video page): a check whose second lies in a card's span and that found
one of the card's AI labels confirms it like an automatic analysis ("✦ Vision
84%"), and joins the card's Vision dialog as "✧ checked by hand". A check is
never listed in the Video page's event list and never makes a card "not
confirmed" or "+ Pet".

## 2. cams server

| Route | Does |
|---|---|
| `POST /api/cameras/:id/still-checks` `{at}` | same-origin (the existing `requireSameOrigin`), per-user rate limits (6 a minute, 60 a day), `at` checked (safe integer, whole second, not in the future), relayed with the client token; the answer rebuilt from parsed fields (summary, objects, events, the image as cams's URL, never `raw`); refusals keep their status and `{error, reason, until, detail}`; logs who asked |
| `GET /api/cameras/:id/still-checks?from&to` | ≤ 31 days, relayed and parsed; an older proxy (404) answers `[]` |
| `GET /api/cameras/:id/still-checks/:checkId` | the check with its objects, never `raw` |
| `GET /api/cameras/:id/still-checks/:checkId.jpg` | the image, streamed (the image rate-limit bucket) |
| `GET /api/cameras/:id/analytics` | the usage, parsed; 404 from an older proxy stays 404 `too_old` |
| SSE relay | `still-check` joins the proxy stream's `types=` (dropped and retried like `analysis` for an older proxy) and goes to browsers as a `change` with `ts: stillTs` |

Proxy URLs are built from parsed numbers only (CodeQL js/request-forgery).

The day's checks for the cards: a `CheckStore` like the AI events' store
(`forDay`, 60 s / 1 h caches, a failed fetch remembered 30 s, dropped by a
`still-check` message for the camera), read by `GET /events` next to the
analyses, and `attachAnalyses(cards, analyses, checks)`.

## 3. Rulings

1. Ruling: a checked second shows its result as soon as it opens, and the
   button turns into "✧ Checked 14:03:22" (disabled) — the design's "only
   opens the result" would be a press that does nothing new — cost if wrong:
   a toggle to hide the boxes (the Plain still radio already does it).
2. Ruling: the large still of a checked second is the check's own JPEG — it
   is what Vision saw, and it outlives the 7-day stills — cost if wrong: the
   plain still URL, one line.
3. Ruling: Shift+← / Shift+→ step between checks — the plain arrows are
   #159's second steps; Shift+arrow has no meaning on the page outside text
   fields (which keep their keys) — cost if wrong: another key.
4. Ruling: the button stays enabled when `GET …/analytics` fails (network,
   502) — the POST answers with the real reason; disabling it on a flaky
   read would hide a working feature — cost if wrong: one press that shows
   an error.
5. Ruling: "Confirms the Person event" names the kind, not the event's time —
   the check's `events` carry ids and kinds only; the cards' times are SD
   recordings, not proxy events — cost if wrong: a lookup in the day's cards.
6. Ruling: per-user limits 6 a minute and 60 a day in cams's memory, keyed by
   the signed-in e-mail — the design's numbers; the proxy's own checks cap
   (10 a day) is the real budget stop — cost if wrong: two numbers. They
   live in cams's memory (the ksvc runs one replica): a restart or a rollout
   starts them over, so they only stop a burst; cam-proxy's checks per day
   (10) and its monthly limit are what bound the spend.
7. Ruling: a check joins a card's analysis only when the card has one anyway
   or the check confirms one of the card's labels — a "nothing relevant"
   check on an unanalysed card adds no empty Vision state to it — cost if
   wrong: a filter.
8. Ruling: a check confirms a card whose span contains its second exactly (no
   5 s slack) — the slack is for event starts, a check is a second inside
   the recording (design §1.2) — cost if wrong: one constant.
9. Ruling: the live `still-check` change reloads the day's checks and the
   usage on any day shown, not only today — a check is made on any day —
   cost if wrong: none.
10. Ruling: the usage line shows the price only when the month's calls are at
    or over 1000 — under the free tier there is nothing to pay — cost if
    wrong: text.

## 4. Tests

- Server: the relay routes (validation, status pass-through, parsing, no
  `raw`, image relay, 404 from an older proxy, rate limits, same-origin), the
  stream type and its fallback, the `change` hint's `ts`, the `CheckStore`,
  `attachAnalyses` with checks (confirms, never "not confirmed", other
  categories ignored, exact span).
- Web lib: the button's state per analytics answer, the error texts, the
  summary line, the marks, prev/next.
- Components: the Timeline's button states, the result in place, reuse,
  errors, marks, the list, ◀ ✧ ▶ and Shift+arrows, the live refresh.
- e2e (desktop and phone, the fake cam-proxy implementing the contract):
  check a second → result, mark, list entry; the same second again → "checked
  before"; disabled when Vision is off; a check in another tab shows live.

---

## 5. Phase 3: "Save clip around this"

cam-proxy's side is its still-checks spec §13 (rulings 38–48 there):
`POST …/compositions {at, preS, postS, size, badge, timeZone?, dryRun?}`,
the window `[at − pre, at + 1 s + post]` from FTP clips where they cover it
and 1 fps stills elsewhere, 409 `nothing_to_compose` when nothing covers it.

**What the user sees.** Under the Timeline's large still, next to
"✧ Check with Vision": **"Save clip around this"** (any second, checked or
not). It opens the existing Save dialog in an "around a second" mode:
title "Save clip around 14:03:22", the still as its picture, pre-roll and
post-roll sliders and numbers (default 10 and 10 → "Result: 21s"), the
size list (SD, 360p, 720p, 1080p), "Mark still sections", the result's
length and limit in the dialog's words ("At most 5m", "At most 2m" at
1080p), and a "Made of" line from a dry run: "FTP clip 14:03:15–14:03:40
and stills (1 per second)", "Stills only (1 per second)", or "Nothing is
kept around this second" (Generate off). Generate, progress, preview and
Save work as for a clip. A still check's result line offers the same
action. The file is `<camera>-<YYYY-MM-DD_HH-MM-SS>-around.mp4`.

**cams server.** `POST /api/cameras/:id/compositions` takes `{at, preS,
postS, size, badge, timeZone?, dryRun?}` instead of `{eventId, …}`
(exactly one), checks it (below), relays it to the proxy and answers the
proxy's status and body; a started job is remembered as today and its
answer gains `name`.

11. Ruling: the dialog is the existing ComposeDialog with an `at` prop
    instead of `clip` — one dialog, its units ("1m 43s"), limits and
    words; the anchor is a 1 s "clip" in `resultLength`, so −10/+10 is
    21 s — cost if wrong: a second component.
12. Ruling: around a second the rolls apply at every size (0…limit; a
    clip's rolls are SD only because other sizes resize the clip alone;
    here the window is the clip) and there is no 4K or plain save (no
    single recording) — cost if wrong: a size list.
13. Ruling: rolls are 0 or more (nothing to cut), and the post-roll stops
    at the seconds already past (the proxy refuses a window that hasn't
    ended); the slider tracks run 0 to the size's limit − 1 s — cost:
    none.
14. Ruling: `at` is checked in cams before relaying: a safe integer, a
    whole second, not in the future, at most 8 days back (the proxy keeps
    7, counted from the start of a UTC day) → 400 `invalid`; the rolls by
    `resultLength(1, pre, post, generateMaxS(size))`; `eventId` and `at`
    together → 400 — cost: none.
15. Ruling: the "Made of" line comes from a dry run, asked 300 ms after
    the last change of rolls or size; a 409 turns Generate off with
    "Nothing is kept around this second (stills and clips are kept 7
    days)"; a failed dry run shows no line and leaves Generate on (the
    real request answers) — cost if wrong: drop the line.
16. Ruling: the file name is made by the cams server, in the camera's
    local time like every other save (#72), from the camera's time
    settings (`GetTime`, cached an hour); when they can't be read, the
    viewer's zone (`timeZone`) is used — the browser doesn't know the
    camera's offset — cost if wrong: a name in another zone.
17. Ruling: the button is offered on every second, also a gap (an FTP clip
    may cover it); the proxy's 409 says when nothing does — cost: none.
18. Ruling: no cams-side limit for compositions beyond the API limit: the
    proxy allows 10 a minute per client and one encode at a time (3
    queued); its `rate_limited` and `busy` are worded in the dialog —
    cost if wrong: a limiter.
19. Ruling: the action also sits at the end of a still check's result
    line, so it is where the eye is after a check — cost: one link.
