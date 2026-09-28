# One video page: Live, History and Downloads (design)

Status: draft for review (Klaus, 2026-09-28).
Builds on the History strip (spec 2026-09-27). It replaces the separate Live
page layout and joins it with the Recordings workspace. The Timeline page
stays as it is.

## Goal

**Live, History and Downloads are one page.** The left column is always the
same:

- the video;
- the line under it, for example `Mon Sep 28, 09:19:53 AM · 3 hours ago ·
  SD 10 FPS · Motion` or `… · LIVE`;
- the strip.

Switching between Live, History and Downloads changes only the panel on the
right, so the video never moves.

**Live is the right end of the strip.** On Live the playhead sits at "now" and
the player shows the live stream. Dragging the strip back, stepping back, or
picking an event turns it into playback without leaving the page. ⇥ goes back
to live.

## Decisions (Klaus, 2026-09-28)

| Topic | Decision |
|---|---|
| Layout | One page. Same player column on Live, History and Downloads; the menu switches the right panel. |
| Wide windows | Spacers either side of the video column fill the extra width (the page colour: near-black dark, white light), so the right panel sits against the right edge |
| Live panel | Camera info (name, real or simulated, online or uptime, streams and quality), the latest event with its thumbnail and "12 minutes ago" (click: plays it), the live controls (sound, SD/HD, snapshot, fullscreen) |
| Strip on Live | The same strip as History, playhead glued to now while live |
| Timeline page | Unchanged |

## Page and URLs

- One component, `Video.svelte` (from `Recordings.svelte` and `Live.svelte`),
  with a panel: `live | history | downloads`.
- The URLs stay:
  - `/app/live` opens panel live at now;
  - `/app/recordings?panel=history|downloads&cam&date&at` as today.
  - Old `panel=events` links still open History.
- The menu is unchanged (Live, History, Downloads, Timeline, Settings,
  About). Each entry opens its panel.
- Moving from live to playback on the Live panel keeps the Live panel, and the
  URL gains `at`. Moving back to live (⇥, or reaching now) drops `at`.
- **Keep-alive:** today App keeps the Live page mounted after you leave it,
  for the chosen time. With one page, the page stays mounted across its three
  panels, and only the live *stream* follows the keep-alive rule:
  - it stays connected while the playhead is at now or was there recently;
  - it closes after the keep-alive time spent in playback or on another page.

## Player column

- **The player** gets a fourth source, **live**, next to clip, stills,
  preview and none. The source is live exactly when the Live panel's playhead
  is "glued" (at now, and not moved away).
- **Live source:** the existing `LivePlayer` (FLV/MSE, SD or HD). When live
  video fails, the existing `LiveStill` fallback shows, with the STILLS badge
  wording in the info line.
- **Info line:** `LIVE · SD 10 FPS` (or `HD 20 FPS`), or `LIVE · STILLS`
  during the fallback. The date and "ago" are left out, since it is now.
- **Glue:**
  - The Live panel opens glued.
  - Any move back (drag, wheel, ‹, ±10 s, a click left of now, picking an
    event) unglues and starts playback there.
  - ⇥, or playback reaching now, glues again.
  - History and Downloads never glue: ⇥ there goes to the latest recorded
    moment, as today.
- **Strip:** as on History. Glued, the playhead mark and the live edge line
  coincide and the window follows now.
- **Width:** `--player-max-w` as today, and the same on every panel.
- **Spacers:** the page is a three-part row, `[spacer] [player column]
  [right panel]`. The spacer takes the extra width, so the right panel sits
  against the right edge. On a phone (one column) there are no spacers; the
  panel goes below the player.

## Right panels

- **Live panel:**
  - **Camera:**
    - the name, and "Simulated camera" when the camera's config says so
      (`"simulated": true` in cameras.json; cam-sim copies the real camera's
      device info, so cams can't tell);
    - the model and firmware (existing status);
    - online, or since when offline;
    - the streams: main H.265 4512×2512 @20, sub H.264 896×512 @10 (from
      `GetEnc`, cached);
    - the cam-proxy state (up or down, with the link from Settings).
  - **Latest event:** its thumbnail, time, kind and "12 minutes ago". Clicking
    it plays it (unglues). A live event that just started shows as
    "recording…" (the live-events pending entry).
  - **Controls:** sound, SD/HD (when the browser supports HEVC), snapshot,
    fullscreen. They move here from under the live video. The offline banner
    and Retry move here too.
- **History panel:** today's event list (filters, newest first, pending
  entries).
- **Downloads panel:** today's download list with thumbnails.

## Server

- `GET /api/cameras/:id/info` → `{ simulated, streams: { main, sub } }`
  (`GetEnc`, cached for 10 minutes), or folded into the existing `status`.
- A camera's config gains the optional `simulated: true` (`cameraRegistry`
  validation; README). Setting it for cam2 is a one-line edit of the
  `cams-cameras` Secret: Klaus makes it, or asks for it explicitly.

## What goes away

- The Live page's own layout and its mini timeline. The compact legend mode
  of `Timeline.svelte` is dropped, and the component goes if nothing else uses
  it.
- `Recordings.svelte` and `Live.svelte` become `Video.svelte` plus three panel
  components.

## Testing

- **Unit:** the glue rules (open glued; unglue on each kind of move; reglue
  on ⇥ or reaching now); the player's live source and switching between live
  and clip or stills.
- **Component:** the panels; the Live panel's latest event and its click;
  the spacer layout (widths measured in e2e, not jsdom).
- **e2e:**
  - Live → History → Downloads: the video box's position and size stay
    identical (measured).
  - Live plays live, dragging back plays the recording, ⇥ is live again.
  - The keep-alive still works.
  - The Live panel shows the camera info and latest event, and clicking the
    event plays it.
  - Phone layout.
  - The existing Live tests move over: snapshot, mute, SD/HD, the offline
    banner, STILLS.

## Out of scope

- A second camera side by side.
- HD playback of recordings.
- Changes to the Timeline page.

## Risks

- **This is the largest change to cams so far.** It touches every page that
  shows video; the e2e suite is the safety net and must move over first.
- **Keep-alive semantics change** from "the Live page" to "the live stream".
  The e2e live-keepalive tests pin the current behaviour and need restating
  against the new rule.
