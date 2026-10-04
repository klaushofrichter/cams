# Fullscreen for recorded video and stills, with navigation (design)

Status: built unsupervised for issue #182 (Klaus mostly away, 2026-10-04); the
open points are decided below as rulings, each with why and what it costs if
it turns out wrong. Builds on the Video page (spec 2026-10-04).

## Goal

- **Bug:** in desktop fullscreen of live the `● LIVE` badge is missing. It
  must show in fullscreen in every mode.
- **#182:** fullscreen for a recording (clip, stills, preview tiles) with its
  own overlay controls, keyboard keys and phone gestures, also on the iPhone
  (where no browser has element fullscreen).
- The Fullscreen button works in both modes; "Fullscreen — only in live mode"
  goes away.

## The badge bug: cause

LiveBox put its own `.livebox` element into fullscreen (`enterFullscreen(box,
video)`). That element is the live layer *inside* the player box; the mode
badge (`data-testid="mode-badge"`) is a sibling of that layer in StripPlayer's
`.box`, so it was outside the fullscreen subtree and the browser didn't draw
it. Fix: one fullscreen target for every mode, the player box (`.box`), which
holds the video, the stills, the live layer, the badge and the new overlay.
LiveBox's own fullscreen (and `liveFullscreen` / `registerLiveFullscreen`) is
removed; the Fullscreen button calls the player's.

## How it works

- **Target:** StripPlayer's `.box` (the player container, not the `<video>`).
  It stays in fullscreen across a switch between live and a recording (⇥, the
  REC badge, a step back from live).
- **Two ways in** (`web/src/lib/playerFullscreen.ts`), chosen by feature
  detection, never by the browser's name:
  - *element fullscreen* when `document.fullscreenEnabled` (or
    `webkitFullscreenEnabled`) is true and the box has `requestFullscreen` (or
    `webkitRequestFullscreen`);
  - else, or when the request is rejected, **fill the screen**: the box becomes
    a fixed full-viewport layer (`position: fixed; inset: 0`, `100dvh`, black,
    safe-area insets for the controls), the page under it doesn't scroll, and
    it works in portrait and landscape. As a home-screen app (the manifest
    says `display: standalone`) there is no browser UI, so it is effectively
    fullscreen.
- A store (`playerFs`: `off` | `element` | `fill`) says which is on; the
  overlay and the key handler follow it. `fullscreenchange` (the browser's
  Esc, Android's Back) turns `element` off.
- **Leaving:** Esc (the browser's in element fullscreen, ours in fill mode),
  the overlay's exit button, Back (fill mode: see the rulings), and the page
  being hidden (another page in the menu): any fullscreen ends.

## The overlay (`FullscreenOverlay.svelte`, only while fullscreen)

- Bottom bar: ⏮ previous event, −10 s, −1 s, play/pause, +1 s, +10 s,
  ⏭ next event, ⇥ back to live, and exit fullscreen. The same rules as the
  controls under the player: in live, play, +1 s, +10 s and next event are off
  and ⇥ is off (already live); −1 s / −10 s / previous event leave live into
  the recording, as they do under the player.
- Previous/next event are the player's own (HistoryView `step`), so they skip
  the events the event filter hides.
- The mode badge (`● LIVE` / `● STILLS` / `REC 14:03:22 · SD|4K|Still`) is the
  player's own badge, top right, always visible (not auto-hidden).
- Auto-hide: hidden 3 s after the last input; a pointer move, a tap, or a key
  shows it again. While hidden the mouse cursor is hidden too.
- Hint: each step, event jump or play/pause from a key or gesture shows a
  short hint in the middle (`−10 s`, `+1 s`, `⏸`, `▶`, `⏮ Event`, `⏭ Event`)
  for 0.7 s.

## Keyboard (while fullscreen)

| Key | Action |
|---|---|
| ← / → | 10 s back / forward |
| Shift+← / Shift+→ | 1 s back / forward |
| `[` / `]`, PgUp / PgDn | previous / next event |
| Space | play / pause (recording only) |
| Esc | leave fullscreen (the browser does it in element fullscreen) |

Alt/Ctrl/Meta with a key stay the browser's. Entering fullscreen moves the focus to the overlay. The keys are read on the
window while fullscreen is on (the focus is often still on the Fullscreen
button in the sidebar, outside the box); the player's own key handler steps
aside meanwhile, so nothing runs twice.

## Phone gestures (while fullscreen, a recording)

A pure recognizer (`web/src/lib/gestures.ts`) classifies one pointer stroke
(touch or pen) from its start, end and duration within the box:

| Stroke | Action |
|---|---|
| swipe left | 1 s forward |
| swipe right | 1 s back |
| tap in the left third | 10 s back |
| tap in the middle third | play / pause |
| tap in the right third | 10 s forward |
| anything else (vertical, long press, a short drag, an edge swipe) | nothing |

Previous/next event are the overlay's buttons (vertical swipes belong to the
system: leave fullscreen, the notification shade).

## Rulings

- Ruling: one fullscreen target, the player box, for every mode — the badge was missing because LiveBox fullscreened only the live layer; one target also keeps fullscreen across live ↔ recording switches — cost if wrong: small; a mode that needs another target would have to put it inside the box.
- Ruling: element fullscreen where the browser has it, else fill-the-screen; no native `<video>` fullscreen (`webkitEnterFullscreen`, option 3) anywhere — native video fullscreen has none of our controls, no badge and no stills — cost if wrong: in an iPhone Safari tab the browser's bars stay visible (a home-screen app has none); a user who wants iOS's own player gets ours instead.
- Ruling: live on the iPhone uses fill-the-screen too — today live fullscreen there tried `requestFullscreen` on the box (absent or refused on iPhone) and then `webkitEnterFullscreen` on the live `<video>`, which plays through Media Source Extensions (mpegts.js) and showed iOS's player without the badge, the stills fallback or the connecting notice, or nothing at all; fill-the-screen shows all of them and behaves like the recording — cost if wrong: the browser's bars stay visible in a Safari tab.
- Ruling: one swipe is one 1 s step, whatever its length — predictable and easy to count; longer moves are taps (10 s) or the strip — cost if wrong: several swipes for a few seconds; a repeat-while-held could be added later.
- Ruling: swipe left = 1 s forward, swipe right = 1 s back, as the issue lists them (like pulling the timeline under the finger) — cost if wrong: a one-line swap.
- Ruling: thresholds: a swipe moves ≥ 40 px horizontally, at least twice as far horizontally as vertically, within 800 ms, and starts ≥ 24 px from the left and right screen edges (iOS uses the edge swipe for Back); a tap moves < 12 px within 500 ms; anything between is ignored — values from common player behaviour; small taps never count as swipes — cost if wrong: tuning two constants after a real-phone test.
- Ruling: the first tap while the overlay is hidden only shows it; a swipe acts at once (and shows it) — a stray tap must not jump 10 s, a swipe is deliberate — cost if wrong: one extra tap before the first 10 s step.
- Ruling: no special double tap; every tap on a side third is 10 s, so two quick taps are 20 s (what common players do with double taps); the gesture layer has `touch-action: none`, so a double tap doesn't zoom — cost if wrong: none known.
- Ruling: gestures only in fullscreen (element or fill), not in the normal player — the page scrolls there and the strip under the player is draggable, so taps and swipes on the picture would fight both — cost if wrong: phone users use the buttons under the player outside fullscreen.
- Ruling: in live mode the picture's taps and swipes only show the overlay; the overlay's buttons do the stepping — a stray tap must not drop out of live — cost if wrong: one more tap to step back from live in fullscreen.
- Ruling: a mouse click on the picture (desktop) plays/pauses a recording; the thirds are for touch and pen only — what desktop players do — cost if wrong: none known.
- Ruling: the overlay hides after 3 s without input, also while paused; the badge never hides — a clear picture when stepping stills; the badge is the mode and was the bug — cost if wrong: one tap or mouse move to bring the controls back.
- Ruling: Back leaves fill-the-screen: entering it pushes a history entry with the same URL, and the router's back guard (new, `guardBack`) swallows that Back, leaves fill mode and keeps the position on screen (the entry below has an older `at`, which would otherwise jump the player back); Esc and the exit button pop the entry when it is still on top — cost if wrong: after ⇥ in fill mode a Back first leaves fill mode, then goes back normally.
- Ruling: the viewport meta keeps no `viewport-fit=cover` — it would put the whole app under the iPhone's notch in landscape, which the rest of the layout isn't made for; in fill mode the page background turns black, so the inset strips beside the notch are black too; the overlay still adds `env(safe-area-inset-*)` so it is right if `cover` ever comes — cost if wrong: a few pixels less picture beside the notch in landscape.
- Ruling: leaving the Video page (it stays mounted, hidden, for the live keep-alive) ends any fullscreen, as LiveBox did for live — a hidden fullscreen element would leave a black screen — cost if wrong: none known.
- Ruling: Space is always play/pause in fullscreen, also with the focus on one of the overlay's buttons (Enter presses the button), and entering fullscreen moves the focus to the overlay — otherwise Space pressed the sidebar's Fullscreen button (where the focus stayed) or the last overlay button clicked, as video players don't — cost if wrong: a keyboard user presses a focused overlay button with Enter, not Space.
- Ruling: the fullscreen live picture fills the screen centred (the live player's own 16:9 stage is stretched to the box in fullscreen); before, it sat at the top — cost if wrong: none known.
- Ruling (review of #185): while fullscreen, everything outside the player box is `inert` (restored on leaving; elements already inert stay so), Tab goes round inside the box, a key aimed at an element outside the box is left to that element, and the focus goes back where it was (the Fullscreen button) once fullscreen has ended — so ←/→ can't run the strip's handler and the overlay's step at once, and keyboard users return to where they were — cost if wrong: none known; the browser's own bar is still reachable with its shortcuts.
- Ruling (review of #185): ⏮ / ⏭ are off at the first / last event the filter shows, and "⏮ Event" / "⏭ Event" is hinted only when the player really jumped (`onstep` says so); the hint is an always-mounted `role="status"` region whose text changes, so screen readers announce it — cost if wrong: none known.
- Ruling (review of #185): an extra history entry left behind when the Video page is left while filling the screen is issue #186, not fixed here — one Back too many, no wrong position.
- Ruling: no WebKit Playwright project — Playwright's WebKit is desktop WebKit even with an iPhone viewport and has element fullscreen, so it would not run the fill path; the phone project (Chromium, 390×844, touch) runs the fill path with the Fullscreen API stubbed away instead, plus touch gestures — cost if wrong: an iPhone-only layout or gesture problem shows up only on a real phone (see "Not verified").

## Tests

- Unit: the gesture recognizer (swipe vs tap, thresholds, edge guard,
  thirds), the key map, the hints, the fullscreen choice (element vs fill,
  rejected request), the router's back guard.
- Component: the overlay (auto-hide, first tap only shows it, buttons per
  mode, hint), StripPlayer in fullscreen (the badge inside the fullscreen box
  in live and recording, keys step 1 s / 10 s, events), VideoControls (the
  Fullscreen button works in both modes).
- e2e (desktop, Chromium): live fullscreen shows the `● LIVE` badge inside the
  fullscreen element; recorded fullscreen: the overlay, 1 s / 10 s steps,
  previous/next event, Esc. Phone (390×844, touch): with
  `requestFullscreen` stubbed away, fill-the-screen covers the viewport in live
  and recording, taps and swipes step, Back and the exit button leave it.

## Not verified (no real iPhone here)

Safari and Chrome on an iPhone, in a tab and as a home-screen app: what the
browser's bars cover in fill mode, the safe areas in landscape, the
rotation, iOS's edge swipe against our edge guard, and whether the thresholds
feel right.
