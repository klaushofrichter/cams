# The Video page: Live and History combined (design)

Status: approved by Klaus (2026-10-04); stage 1 is built in the PR that adds
this file, stage 2 is a later PR.
Builds on the unified video page (spec 2026-09-28), which already put Live
and History beside one player and one strip, as two panels behind two menu
entries and two tab buttons. This design drops the panels: there is one page,
and what it shows follows the player.

## Goal

**One page, "Video".** One menu entry, one page title. The player and the
strip don't change. The **mode** follows the player:

- at "now" (the playhead glued to the strip's right end) it is **live**: the
  live stream plays;
- scrubbed back (a drag, a step, an event, a day) it is **recording**: the
  clip, the proxy's stills or the preview tiles of that time play.

A badge on the player says which: `● LIVE`, or `REC 14:03:22` (with the day
when it isn't today, `REC Oct 3, 14:03:22`). ⇥ on the strip (as today) and a
click on the REC badge go back to live.

## Decisions (Klaus and the coordinator, 2026-10-04)

| Topic | Decision |
|---|---|
| Menu | One entry, **Video** (`/app/video`), replacing Live and History |
| Title | "Video" in both modes |
| Old URLs | `/app/live` opens live, at now; `/app/recordings?…` (with `date`, `at`, or an old `clip`&`t`; `panel=` of any value) opens the recording at that day and time. Both are rewritten to `/app/video…` in place (replace, no extra history entry) |
| Mode | Follows the player: glued → live, else recording. No tab buttons |
| Badge | `● LIVE` / `REC <time>` on the player; a click on REC (or ⇥) is live again |
| Sidebar | Top to bottom: camera card, controls card, event filter chips, the event list by hour with "Collapse hours" |
| Camera card | The camera's name, linked to its web UI (`webUiUrl`; the `webUiNote` as a tooltip without one), a small right-aligned "Proxy" link when the camera has a cam-proxy (the one-time login-link flow), and a status dot: online, offline, checking. The name comes from the camera store (#169), so a rename shows at once. Offline: the offline message, since when, and Retry, as before |
| Model, firmware | Only in Settings → Device and maintenance (already there); the sidebar no longer shows model, firmware, simulator or streams |
| Controls | Sound, quality (SD/4K), light, snapshot, fullscreen. Quality and light are disabled outside live mode, with the tooltip "Only in live mode". Sound stays. Snapshot and fullscreen work in both modes |
| Snapshot | Live: the camera's full-resolution snapshot, as today. Recording: the frame on screen: a clip's `<video>` frame drawn on a canvas at the clip's own resolution (same origin, so the canvas isn't tainted); a still: the still itself; a preview tile: the tile cut from its sprite. "No recording": nothing to save (disabled, "Nothing to save here"). The file name says which: `cam1-live-…jpg`, `cam1-rec-…jpg`, `cam1-still-…jpg` (the time stamp as before: the moment saved, UTC, `YYYY-MM-DD-HH-MM-SS`) |
| Event list | History's list (hour groups, newest first, "Collapse hours") for the day being viewed. Live: today's list; a new event appears at the top (the "recording…" card, then the event). Another day: nothing moves by itself |
| Removed | The Live/History tab buttons and the "Most recent events" five-list |
| Keep-alive | Leaving live for a recording is like leaving the Live page today: the stream stays open for the keep-alive time, then closes; back to live within it is instant. The same mechanism (`createKeepAlive`, `liveStreamHeld`) |

## What moves where

| Before | After |
|---|---|
| Menu: Live, History | Menu: Video |
| Title: "Live" / "History" | "Video" |
| Tabs Live / History above the panel | gone |
| Live panel tile: name, real/simulated, model · firmware, Live/Connecting…, streams, "cam-proxy: connected" | Camera card: name (link), Proxy (link), status dot; the rest is in Settings or on the player's info line (source badge, LIVE/STILLS) |
| Live panel controls (only while online) | Controls card, always there (quality and light live only) |
| "Most recent events" (five, Live only) | The day's event list, both modes |
| History's event list and "Collapse hours" (History only) | The same, both modes, under the filter chips |
| Day picker and "Updated" (History only, hidden on Live) | Always shown; picking a day is a recording on that day |
| `live-badge` / STILLS on the info line | unchanged; the mode badge on the player is new |

## Routing

`parseRoute` gives page `video` for `/app/video`, `/app/live`,
`/app/recordings` and anything unknown, and a requested mode:

- `/app/video`: recording when `at`, `date` or `clip` is present, else live;
- `/app/live`: live, unless an old `at=` link (recording);
- `/app/recordings`: always recording; without a position the session's last
  position (as History did), else the day's first event;
- `legacy: true` for any path other than `/app/video`.

On a legacy route the page replaces the URL with its `/app/video` form (live:
`/app/video`; recording: `/app/video?cam&date&at` or the old `clip&t`).
The query no longer carries `panel`. The server sends a signed-in `/` to
`/app/video`. Timeline's "Open in History", the Vision dialog's link and the
logo point at `/app/video?…`.

## Mode state machine

```
             ⇥ / REC badge / playback reaches now / route without position
   ┌────────────────────────────────────────────────────────────────┐
   ▼                                                                │
 LIVE (glued: playhead = now − 2 s, live stream)       RECORDING (at = t)
   │                                                                ▲
   └────────────────────────────────────────────────────────────────┘
     drag/scroll back, ±1/10 s, an event card, a day, a route with a position
```

- The state is HistoryView's `glued` (bound to the page); `mode = glued ?
  'live' : 'rec'` (`lib/videoMode.ts`).
- The strip's live end is always on now (HistoryView `live` is always true).
- Live → recording pushes `/app/video?cam&date&at` (Back returns to live);
  while recording, the position replaces the URL (at most every 2 s, as now).
- Recording → live pushes `/app/video`.
- A route change to a URL without a position is live; with one, a recording
  there (paused, as History's links were).
- Kept alive behind another page, the page never touches the URL (as now).

## Keep-alive

Unchanged mechanism: `onLive = glued && pageVisible && tabVisible`. While
`onLive` the stream is wanted; when it turns false (a recording, another page,
a hidden tab) `createKeepAlive` holds it for `liveKeepAlive` seconds, then
lets go. LiveBox stays mounted (hidden) meanwhile, so a return to live within
the time plays at once. App keeps the page mounted while `liveStreamHeld`.

## Snapshot per mode

`lib/videoMode.ts`:

- `snapshotName(cam, kind, t)`: `<cam>-<kind>-YYYY-MM-DD-HH-MM-SS.jpg`, kind
  `live` / `rec` / `still`.
- StripPlayer registers a player handle (`registerPlayer`): `frame()` says
  what is on screen (`clip` with its `<video>`, `still` with its URL, `tile`
  with the sprite URL and the crop, or nothing) and `fullscreen()` puts the
  player box in fullscreen.
- `saveFrame(cam, frame)`: clip → canvas at `videoWidth × videoHeight`,
  `toBlob('image/jpeg', 0.92)`; still → fetched (an image, else an error);
  tile → the sprite drawn cropped onto a canvas. Errors use the existing
  `snapshotError` line.
- Live keeps `saveSnapshot` (the camera's `snapshot.jpg`), now named
  `…-live-…`.

## Tests

- Unit (`lib/videoMode.test.ts`, `lib/router.test.ts`): mode from glued, the
  badge text (today, another day), snapshot names, the frame → blob paths
  (canvas mocked), route parsing of `/app/video`, `/app/live`,
  `/app/recordings` (requested mode, legacy flag), the nav (one "Video"),
  canonical hrefs.
- Components: `CameraCard` (name follows the store, web UI link / note, Proxy
  link and its login-link click, status dot states, offline banner, Retry),
  `VideoControls` (light and quality disabled in recording with the note,
  sound enabled, snapshot per mode with the file name, fullscreen per mode,
  light switching and its 2 s hold, ported from LivePanel's tests),
  StripPlayer (the badge in both modes, a click on REC calls `onglue`).
- e2e, desktop and phone: `/app/live` and `/app/recordings?…` land on
  `/app/video…` in the right mode; the nav has one "Video" entry; scrubbing
  back shows REC and disables light and quality; ⇥ and the badge are LIVE
  again; snapshot downloads a JPEG in both modes with the right name; the
  camera card shows a rename. The specs that used the tabs, `panel=history`
  URLs or the five-list are moved to the event list and the new URLs.

## Stage 2 (a later PR, not built now)

- **Auto-collapse:** hour groups more than 6 h from the viewed time start
  collapsed, only when landing on a new spot (a day picked, an event card, a
  link, a time picked), never while scrubbing or playing. A group the user
  opened or closed keeps the user's choice (user toggles win).
- **Lazy thumbnails:** the cards' thumbnails load when they scroll into view
  (IntersectionObserver on the list's scroll box, a small root margin), not
  all at once for a busy day.
