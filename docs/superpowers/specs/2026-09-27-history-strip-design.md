# History: one continuous strip (design)

Status: approved design (Klaus, 2026-09-27); spec for review.
Replaces the History timeline's window model (zoom around the selected clip,
‹ › buttons from #49). Everything else from #49 stays: the player size
(`--player-max-w`), the steady day picker, the saved zoom, hover previews, the
no-thumbnail hatching of event cards.

## Goal

History plays a camera's past as **one continuous strip**. The playhead stays in
the centre and time slides under it. Playback runs in real time and moves
between event clips, the cam-proxy's stills, and stretches with nothing
recorded without stopping. It continues across midnight. A badge on the video
says which kind of picture is showing.

## Decisions (Klaus)

| Topic | Decision |
|---|---|
| Navigation | Centred playhead at **every** zoom; no mode switch by zoom |
| Zooms | 24, 12, 6, 3, 1 h (the saved `timelineZoom` preference gains 12 and 3) |
| Between clips | Stills at real speed where the proxy has them |
| Nothing recorded | **Play through in real time**, with a "No recording" panel |
| Midnight | **Continuous across days**; the URL date follows the playhead |
| Several sources | The clip (SD) first, stills otherwise; HD stays a download |
| Timeline page | Unchanged (a day's stills grid); a tile may link into History |
| Colours | Stretches with nothing to show: grey (past) or black (future) |
| Source badge | A corner overlay: `SD 10 FPS`, `Stills 1 FPS`, … |

## Sources

What is at a moment `t`, in priority order:

| Source | Where from | Kept | Badge | Strip colour |
|---|---|---|---|---|
| Event clip (sub stream, H.264) | the proxy first, else the camera (`/clips/:id/video`) | proxy 24 h, camera SD card 7 days | `SD 10 FPS` (from the stream's real frame rate when known) | event segments, as now |
| Still (896×512 JPEG, 1 per second) | proxy, `/stills/:ts.jpg` | 24 h (less when storage is tight) | `Stills 1 FPS` | bar colour (`--surface-2`) |
| Preview tile (160×90, 1 per second, in minute sprites) | proxy, `/previews` | 72 h | `Preview 1 FPS` | bar colour, dimmer |
| Nothing | | | `No recording` | `--strip-empty` (grey) |
| Future (after now) | | | | `--strip-future` (black) |

- Retention is never assumed. Coverage comes from what the proxy and the camera
  list, so a proxy that is down, new or short of storage just shows grey.
- A camera without a cam-proxy (cam1 today) has clips and grey gaps only.
- The camera's clip list (the day's `events`) marks the clip spans. A clip
  that turns out unplayable (camera refusing, proxy without it) is treated as
  stills or nothing for that span, and its segment is marked (a hatched segment).

## Model (pure, `web/src/lib/strip.ts`)

Times are UTC milliseconds. Days are local calendar days (DST-safe, as in
`lib/recordings.ts`).

```ts
type Source =
  | { kind: 'clip'; clip: EventClip; offsetMs: number }
  | { kind: 'still'; ts: number }        // the still at or before t
  | { kind: 'preview'; ts: number }
  | { kind: 'none' }
  | { kind: 'future' };

interface Coverage {            // for a camera, over any span of days
  clips: { start: number; end: number; clip: EventClip }[];
  stills: { start: number; end: number }[];    // runs of 1-per-second stills
  previews: { start: number; end: number }[];  // runs of present tiles
}

sourceAt(cov: Coverage, t: number, now: number): Source;
nextChange(cov: Coverage, t: number, now: number): number | null; // next t where sourceAt changes
stripSpans(cov: Coverage, win: { start: number; end: number }, now: number): Span[]; // coloured spans, percent
windowAround(t: number, zoomH: 24 | 12 | 6 | 3 | 1): { start: number; end: number };
```

- Stills coverage: runs built from the proxy's `stills?from&to` list, fetched
  per hour (at most 3,600 timestamps) around the playhead. It is not fetched
  for the whole strip. The strip's colours use the preview minutes, which are
  cheap, one per minute.
- Previews coverage: the `present[]` runs of each minute sprite (as in
  `thumbCoverage`).
- Unit tests: priority, boundaries, DST days, midnight, a missing hour of
  stills, the future.

## Player (`web/src/components/StripPlayer.svelte`)

One clock: `{ t, playing }`.

- **Clip:** a `<video>` of the clip. `t = clip.start + currentTime`. At the
  clip's end, the clock continues at `clip.end`.
- **Still / preview / none:** a wall-clock ticker (requestAnimationFrame, real
  elapsed time) advances `t`.
  - A still is shown as an `<img>`, updated each second. The next 3 stills are
    loaded ahead, and a failed one keeps the previous frame.
  - A preview shows the sprite tile, scaled up (it looks soft; the badge says
    why).
  - None shows the "No recording" panel with the time.
  - Future: playback stops at now, and the panel says "Live is on the Live
    page".
- **Transitions:** when `t` reaches `nextChange`, the player switches source.
  About 3 s before a clip starts, it loads the clip's video, so it starts
  without a gap.
- **Controls:** play/pause, ±10 s, previous or next event (jumps `t` to that
  event's start), and download (the event under the playhead, as now). Space
  toggles play; ← and → step 10 s.
- **Badge:** top left over the video, with the same styling as the Live badges.
- **Errors:**
  - A clip that fails to load falls back to stills or none for its span, and
    the strip marks it.
  - The recordings-unavailable banner and the proxy note stay as now.

## Strip (`web/src/components/Strip.svelte`, replacing History's `Timeline`)

- The window is `windowAround(t, zoom)`, and the playhead is a fixed centre
  line.
- **Colours:** `stripSpans` gives the spans; event segments sit on top, as
  now. The "now" line is shown on today.
- **Interaction:**
  - Dragging moves `t`. Playback pauses while dragging and resumes after if it
    was playing.
  - Horizontal wheel or trackpad scrolling moves `t`.
  - A click sets `t` to the time under the pointer.
  - Hover previews stay as they are (frame, or the event thumbnail).
- **Zoom buttons:** 24, 12, 6, 3, 1 h, saved as today.
- **Ticks:** labelled with the time of day, plus a date label at midnight
  ("Sat 27").
- **Data:** per local day, the day's events, previews and clip coverage are
  cached in memory by `(camera, day)`. The days that overlap the window,
  **plus one day either side**, are loaded, so playing or dragging across
  midnight never waits. Today's data refreshes as now (SSE or the minute
  poll).
- The Live page's mini timeline keeps the current `Timeline` component
  (legend mode), which this project does not change.

## Page (Recordings.svelte, History panel)

- **URL:** `?cam=<id>&t=<ms>` (plus `panel`, `filter`).
  - The date shown (day picker, `date` in the URL) follows the playhead's
    local day.
  - Old links (`date`, `clip`, `t` as the offset in seconds) are converted to
    `t` on load.
  - While playing, the URL is updated at most every 2 s, with a replace
    rather than a new history entry.
- **Day picker:** changing the date sets `t` to that day's first event (or
  00:00).
- **Events list:** the event under or just before the playhead is highlighted
  and scrolled into view. Clicking an event sets `t` to its start and plays.
- **Filter** (person, vehicle and so on): applies to the list and dims other
  segments on the strip. Playback still plays everything in time order.
- **Downloads panel, Events panel, Timeline page:** unchanged apart from the
  highlight.
- **Timeline page:** a minute tile gets a link, "Open in History", to `t`
  (small; optional in this project).

## Theme

New tokens, defined in all three theme blocks:

- `--strip-empty`: grey. Dark `#1B2233`, light `#C9D2DF`.
- `--strip-future`: near black. Dark `#05080F`, light `#9AA6B8`.
- `--strip-preview`: the dimmer bar colour.

The no-thumbnail hatch stays for event cards. On the strip, grey replaces the
hatch.

## Testing

- **Unit (`strip.ts`):** everything under Model.
- **Component, player:** with fake timers and a fake `<video>`:
  - clip → stills at the clip's end;
  - stills → none → clip, with the preload;
  - a failed clip falls back;
  - pause and resume;
  - the badge text;
  - playback stops at now.
- **Component, strip:**
  - the centred window;
  - dragging and the wheel move `t`;
  - span colours;
  - loading the day on either side;
  - the zoom set.
- **e2e:**
  - play a Barn clip into stills (fake proxy) and check the badge changes;
  - drag the strip to yesterday: the URL date changes and yesterday's events
    appear;
  - an old `clip=` link opens at the right moment;
  - check the phone layout.
  - The e2e fixtures need stills around a clip's end (fakeProxyData) and a
    stretch without anything.

## Out of scope

- HD playback in the player. Main-stream playback in the browser needs HEVC,
  and the real camera's download is slow.
- Faster-than-real-time playback (for example 2× or 10×). This is a natural
  next step.
- Changes on Live and on the Timeline page, beyond the optional link.
- Server changes. The existing APIs cover it: `events`, `days`, `previews`,
  `stills`, `stills/:ts.jpg`, `clips/:id/video`.

## Risks

- **A 24 h window at real time looks static.** That's expected. The strip only
  visibly moves at 1–3 h.
- **The stills list size:** it is fetched per hour, only around the playhead.
- **The stills rate:** 1 request per second while playing stills is fine on
  the LAN. The media rate limit is 3,000 requests per 5 minutes (checked),
  about 10 per second, so one viewer playing stills with preloads uses about
  a tenth of it.
