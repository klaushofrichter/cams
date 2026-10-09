<!-- web/src/components/StripPlayer.svelte -->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import ComposeDialog from './ComposeDialog.svelte';
  import { cameraById } from '../lib/stores';
  import { nextChange, sourceAt, type Coverage, type Source } from '../lib/strip';
  import { localDate, orderTriggers, TRIGGER_LABELS, videoUrl, type EventClip } from '../lib/recordings';
  import { navigate } from '../lib/router';
  import { localClock, timeAgo } from '../lib/clock';
  import { previewAt, tileStyle, type PreviewMinute } from '../lib/timeline';
  import { liveUi } from '../lib/liveUi';
  import FullscreenOverlay from './FullscreenOverlay.svelte';
  import { enterPlayerFullscreen, exitPlayerFullscreen, playerFs, type FsAction } from '../lib/playerFullscreen';
  import { clipShown, liveBadge, modeBadge, modeOf, registerPlayer, type PlayerFrame, type RecShown } from '../lib/videoMode';
  import { enterClip, IDLE_SEEKER, seekRequest, seekSettled, showClipVideo, SWAP_DWELL_MS, SWAP_TOLERANCE_S, type Entered, type Seeker } from '../lib/clipSwap';

  // History's player (spec 2026-09-27): one clock, `at`. A clip's <video>
  // drives it while a clip plays; otherwise a real-time ticker does, showing
  // stills, preview tiles or "No recording". Two <video> elements take turns
  // so the next clip is loaded 3 s before it starts.
  let {
    cam, coverage, previews, now, at = $bindable(), playing = $bindable(), unavailable = false, onclipfail, onstep,
    glued = false, live: liveSnippet, onglue, clipStream = 'sub', stepAvail = { prev: true, next: true }, scrubbing = false,
  }: {
    cam: string;
    coverage: Coverage;
    previews: PreviewMinute[];
    now: number;
    at: number;
    playing: boolean;
    unavailable?: boolean;
    onclipfail: (clipId: string) => void;
    onstep: (dir: -1 | 1) => boolean | void; // true: it jumped to an event
    stepAvail?: { prev: boolean; next: boolean }; // an event before / after the playhead (fullscreen ⏮ / ⏭)
    glued?: boolean; // the Live panel's playhead is at now: show the live stream
    live?: Snippet; // the live stream; kept mounted while unglued so it resumes at once
    onglue?: () => void; // the REC badge: back to live (spec 2026-10-04)
    // The stream a clip's video plays (HistoryView passes VIDEO_STREAM, the
    // clip route's: sub, SD); main says 4K.
    clipStream?: 'sub' | 'main';
    // The timeline is being dragged (Klaus, 2026-10-09): a clip's video loads
    // and seeks under the still and shows only once it has the frame.
    scrubbing?: boolean;
  } = $props();

  // Live has no "after": forward 1 s and 10 s and next event are off there (#121).
  const NOT_LIVE = 'Not available in live view';

  // The Timeline needs the camera's cam-proxy (its stills), as does the save
  // dialog's composing.
  const hasProxy = $derived(!!$cameraById(cam)?.proxy);
  const timelineHref = $derived(hasProxy && !glued
    ? `/app/timeline?cam=${encodeURIComponent(cam)}&date=${localDate(new Date(at))}&t=${Math.floor(at / 1000) * 1000}`
    : null);

  const TICK_MS = 250;
  const PRELOAD_MS = 3000;
  const BADGE: Record<Source['kind'], string> = {
    clip: 'SD 10 FPS', still: 'Stills 1 FPS', preview: 'Preview 1 FPS', none: 'No recording', future: 'Later than now',
  };
  // Glued: what the live stream is, from the camera's streams (spec 2026-09-28).
  const liveSource = $derived.by(() => {
    const u = $liveUi;
    if (u.playerState !== 'playing' && u.stillsShowing) return BADGE.still; // not "STILLS" twice (Klaus 2026-10-06)
    const s = u.quality === 'main' ? u.status?.streams?.main : u.status?.streams?.sub;
    return `${u.quality === 'main' ? '4K' : 'SD'} ${s?.fps ?? (u.quality === 'main' ? 20 : 10)} FPS`;
  });
  const stillUrl = (ts: number) => `/api/cameras/${encodeURIComponent(cam)}/stills/${ts}.jpg`;

  const source = $derived(sourceAt(coverage, at, now));
  // Downloads go through the save dialog, as on the History cards (Klaus, 2026-09-29).
  let saving: EventClip | null = $state(null);
  const downloadable = $derived(!glued && source.kind === 'clip' && !unavailable ? source.clip : null);

  // --- video A/B ---
  let vids: (HTMLVideoElement | undefined)[] = $state([undefined, undefined]);
  let srcs = $state<[string | null, string | null]>([null, null]);
  let active = $state(0);
  const failedOnce = new Set<string>();
  let followVideo = false; // true while the active video drives `at`
  const idOf = new Map<string, string>(); // video url → clip id (for errors on either slot)
  const awaitingMeta = [false, false]; // a slot's new src: its position isn't the clip's yet
  // A step (±1 s, ±10 s) seeks the video even when it moves less than the
  // drift allowed below: paused, the new frame shows; playing, the video's
  // own time doesn't undo the step (Klaus, 2026-10-03).
  let seekNext = false;

  // --- the still over a clip that isn't ready (Klaus, 2026-10-09; lib/clipSwap.ts) ---
  // Each slot's presented frame (seconds into its clip; null: none yet for
  // this src), from requestVideoFrameCallback where there is one and from
  // seeked / loadeddata / timeupdate with a decoded current frame.
  let presented = $state<[number | null, number | null]>([null, null]);
  let slotErr = $state<[boolean, boolean]>([false, false]);
  const errWhileScrubbing = [false, false]; // reported only if it fails again where the drag stops
  const seekers: Seeker[] = [IDLE_SEEKER, IDLE_SEEKER];
  let videoShown = $state(false);
  function setSrc(i: number, url: string) {
    srcs[i] = url;
    awaitingMeta[i] = true;
    presented[i] = null;
    slotErr[i] = false;
    errWhileScrubbing[i] = false;
    seekers[i] = IDLE_SEEKER;
  }
  // A seek at once (the newest target replaces any waiting one).
  function seekNow(i: number, t: number) {
    const v = vids[i];
    if (!v) return;
    seekers[i] = { inFlight: true, pending: null };
    try {
      v.currentTime = t;
    } catch {
      seekers[i] = IDLE_SEEKER; // before metadata: applied on loadedmetadata
    }
  }
  // While dragging: one seek in flight, only the newest target waits.
  function seekCoalesced(i: number, t: number) {
    const v = vids[i];
    if (!v) return;
    const r = seekRequest(v.seeking ? seekers[i] : IDLE_SEEKER, t);
    seekers[i] = r.next;
    if (r.seek !== null) seekNow(i, r.seek);
  }
  function framePresented(i: number) {
    const v = vids[i];
    if (v && !v.seeking && v.readyState >= 2 && srcs[i]) presented[i] = v.currentTime;
  }
  function onSeeked(i: number) {
    const r = seekSettled(seekers[i]);
    if (r.seek !== null) return seekNow(i, r.seek);
    seekers[i] = IDLE_SEEKER;
    framePresented(i);
  }
  // requestVideoFrameCallback: the time of the frame actually presented.
  $effect(() => {
    const els = [vids[0], vids[1]];
    const handles: (number | undefined)[] = [undefined, undefined];
    els.forEach((v, i) => {
      if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
      const cb = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (srcs[i] && untrack(() => presented[i]) !== meta.mediaTime) presented[i] = meta.mediaTime;
        handles[i] = v.requestVideoFrameCallback(cb);
      };
      handles[i] = v.requestVideoFrameCallback(cb);
    });
    return () => els.forEach((v, i) => {
      if (v && handles[i] !== undefined) v.cancelVideoFrameCallback?.(handles[i]!);
    });
  });

  function urlOf(id: string) {
    const url = videoUrl(cam, id);
    idOf.set(url, id);
    return url;
  }
  function failClip(id: string) {
    if (failedOnce.has(id)) return;
    failedOnce.add(id);
    onclipfail(id);
  }
  // Put the clip in the active slot (swapping when the other slot preloaded it).
  $effect(() => {
    const s = source;
    const wantPlay = playing; // read first: every early return below still re-runs on play/pause
    const drag = scrubbing; // and on a drag's start and end
    const forced = seekNext;
    seekNext = false;
    if (s.kind !== 'clip') {
      followVideo = false;
      vids[active]?.pause();
      return;
    }
    const url = urlOf(s.clip.id);
    if (srcs[active] !== url) {
      if (srcs[1 - active] === url) {
        active = 1 - active; // preloaded (its metadata may still be on the way)
        if (vids[active]?.error) {
          slotErr[active] = true;
          if (drag) errWhileScrubbing[active] = true;
          else return failClip(s.clip.id);
        }
        if (awaitingMeta[active]) {
          followVideo = false;
          return;
        }
      } else {
        // A new source resets the element's position to 0: don't follow it
        // until loadedmetadata has put it at the wanted offset.
        setSrc(active, url);
        followVideo = false;
        return;
      }
    }
    const v = vids[active];
    if (!v) return;
    // It failed during the drag and the drag stopped here: once more, and a
    // second failure is reported (onVideoError) like any other.
    if (!drag && errWhileScrubbing[active]) {
      setSrc(active, url);
      try {
        v.load();
      } catch {
        // jsdom
      }
      return;
    }
    if (awaitingMeta[active] || slotErr[active]) return;
    const want = s.offsetMs / 1000;
    const cur = v.currentTime || 0;
    if (drag) {
      // Dragging: the hidden video follows the newest position only.
      if (Math.abs(want - (seekers[active].pending ?? cur)) > 0.1) seekCoalesced(active, want);
    } else if (!followVideo || forced || Math.abs(cur - want) > 1.5 || (!untrack(() => videoShown) && Math.abs(cur - want) > SWAP_TOLERANCE_S)) {
      seekNow(active, want);
    }
    followVideo = true;
    if (wantPlay) tryPlay(v);
    else v.pause();
  });
  // Preload the next clip into the idle slot 3 s ahead.
  $effect(() => {
    if (!playing) return;
    const next = nextChange(coverage, at, now);
    if (next === null || next - at > PRELOAD_MS) return;
    const s = sourceAt(coverage, next, now);
    if (s.kind === 'clip' && srcs[active] !== urlOf(s.clip.id) && srcs[1 - active] !== urlOf(s.clip.id)) {
      setSrc(1 - active, urlOf(s.clip.id));
    }
  });
  // Only the browser's autoplay block stops playback; a play() that fails
  // because the new clip isn't loaded yet is retried on canplay.
  function tryPlay(v: HTMLVideoElement) {
    void v.play().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'NotAllowedError') playing = false;
    });
  }
  function onCanPlay(i: number) {
    const v = vids[i];
    if (v && i === active && playing && source.kind === 'clip' && v.paused) tryPlay(v);
  }
  function onVideoTime(i: number) {
    const s = source;
    framePresented(i);
    // Only playback moves the clock: a seek's timeupdate while paused or
    // dragging is an older position than the cursor's (coalesced seeks).
    if (i !== active || s.kind !== 'clip' || !followVideo || !playing || scrubbing) return;
    const v = vids[i]!;
    at = Date.parse(s.clip.start) + v.currentTime * 1000;
  }
  function onVideoEnded(i: number) {
    const s = source;
    if (i !== active || s.kind !== 'clip') return;
    at = Date.parse(s.clip.end);
  }
  // Either slot: a preloaded clip that fails is failed before its turn.
  // While dragging, a failure only keeps the still (no error flash): it is
  // tried again where the drag stops.
  function onVideoError(i: number) {
    const id = srcs[i] ? idOf.get(srcs[i]!) : undefined;
    slotErr[i] = true;
    seekers[i] = IDLE_SEEKER;
    if (scrubbing) {
      errWhileScrubbing[i] = true;
      return;
    }
    if (id) failClip(id);
  }
  function onMeta(i: number) {
    const s = source;
    awaitingMeta[i] = false;
    if (i !== active || s.kind !== 'clip' || srcs[i] !== urlOf(s.clip.id)) return;
    seekNow(i, s.offsetMs / 1000);
    followVideo = true;
    if (playing) tryPlay(vids[i]!);
  }

  // The swap: the video shows only with a frame at the cursor (and, while
  // dragging, after the cursor has stayed in the clip for a moment); until
  // then the still layer covers it. Leaving the clip is the still at once.
  let entered: Entered | null = null;
  let dwellTimer: ReturnType<typeof setTimeout> | undefined;
  let dwellTick = $state(0);
  $effect(() => {
    const id = source.kind === 'clip' ? source.clip.id : null;
    untrack(() => {
      const e = enterClip(entered, id, Date.now());
      if (e === entered) return;
      entered = e;
      clearTimeout(dwellTimer);
      if (e) dwellTimer = setTimeout(() => dwellTick++, SWAP_DWELL_MS);
    });
  });
  $effect(() => () => clearTimeout(dwellTimer));
  $effect(() => {
    const s = source;
    void dwellTick;
    const i = active;
    const want = !glued && s.kind === 'clip' ? { url: urlOf(s.clip.id), offsetS: s.offsetMs / 1000 } : null;
    const show = showClipVideo({
      want,
      slot: { url: srcs[i], presentedS: presented[i], error: slotErr[i] },
      scrubbing,
      dwellMs: untrack(() => (entered ? Date.now() - entered.since : 0)),
      shown: untrack(() => videoShown),
    });
    if (show !== untrack(() => videoShown)) videoShown = show;
  });

  // --- the real-time ticker (not for clips) ---
  $effect(() => {
    if (!playing) return;
    let last = Date.now();
    const id = setInterval(() => {
      const t = Date.now();
      const dt = t - last;
      last = t;
      if (source.kind === 'clip') return;
      const next = Math.min(at + dt, now);
      at = next;
      if (next >= now) playing = false;
    }, TICK_MS);
    return () => clearInterval(id);
  });

  // --- stills: shown once loaded; a failed one keeps the last good frame.
  // Each still is asked for once; a failed one not again for 10 s (a proxy
  // that went away must not turn playback into a request storm).
  const STILL_RETRY_MS = 10_000;
  let stillShown = $state<string | null>(null);
  const stillState = new Map<string, number>(); // url → 0 loading, 1 loaded, else the time it failed
  function loadStill(ts: number, show: boolean) {
    const url = stillUrl(ts);
    const st = stillState.get(url);
    if (st === 1) {
      if (show) stillShown = url;
      return;
    }
    if (st === 0 || (st !== undefined && Date.now() - st < STILL_RETRY_MS)) return;
    stillState.set(url, 0);
    const img = new Image();
    img.onload = () => {
      stillState.set(url, 1);
      if (pic?.kind === 'still' && stillUrl(pic.ts) === url) {
        stillShown = url;
        if (stillPending === pic.ts) stillPending = null;
      }
    };
    img.onerror = () => stillState.set(url, Date.now());
    img.src = url;
    // Keep the map to the last ten minutes or so of seconds.
    if (stillState.size > 700) for (const k of [...stillState.keys()].slice(0, 100)) stillState.delete(k);
  }
  // The picture layers: the source, or over a clip whose video isn't on
  // screen yet, the still or preview tile of that second.
  const covering = $derived(!glued && source.kind === 'clip' && !videoShown);
  const pic = $derived.by((): Source | null => {
    if (source.kind !== 'clip') return source;
    return covering ? sourceAt({ ...coverage, clips: [] }, at, Infinity) : null;
  });
  const stillTs = $derived(pic?.kind === 'still' ? pic.ts : null);
  // Playing forward, stills load as they come (a second at a time). Any
  // other move (a drag, a jump, a step) loads only where it settles, after
  // 150 ms; meanwhile the minute's sprite tile stands in. A drag across
  // hours once asked for 2,542 stills in a minute (2026-09-29).
  const SETTLE_MS = 150;
  let lastStillTs: number | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let stillPending = $state<number | null>(null);
  $effect(() => {
    const ts = stillTs;
    clearTimeout(settleTimer);
    if (ts === null) {
      stillPending = null;
      return;
    }
    untrack(() => {
      const load = (t: number) => {
        // The tile stays until there is a still to show (the first one
        // loading: nothing else would be on screen).
        if (stillShown !== null || stillState.get(stillUrl(t)) === 1) stillPending = null;
        loadStill(t, true);
        for (let k = 1; k <= 3; k++) loadStill(t + k * 1000, false);
      };
      const step = lastStillTs === null ? 0 : ts - lastStillTs;
      lastStillTs = ts;
      if (playing && step > 0 && step <= 2000) return load(ts);
      stillPending = ts;
      settleTimer = setTimeout(() => load(ts), SETTLE_MS);
    });
  });
  $effect(() => () => clearTimeout(settleTimer));
  const pendingTile = $derived(stillPending !== null ? previewAt(previews, stillPending) : null);

  // --- preview tile, scaled up to the box ---
  let boxW = $state(0);
  const tile = $derived(pic?.kind === 'preview' ? previewAt(previews, pic.ts) : null);

  // The Video page's snapshot in a recording (spec 2026-10-04): what is on
  // screen (live has the camera's own snapshot). Fullscreen is this box in
  // every mode (#182): it holds the picture, the live layer and the badge.
  let boxEl: HTMLDivElement | undefined = $state();
  function frame(): PlayerFrame | null {
    if (glued) return null;
    const v = vids[active];
    const clip: PlayerFrame | null = source.kind === 'clip' && v ? { kind: 'clip', video: v, at } : null;
    const s = pic;
    if (!s || (s.kind !== 'still' && !(s.kind === 'preview' && tile?.minute.url))) return clip; // nothing covers it: the video, as before
    if (s.kind === 'still') return { kind: 'still', url: stillUrl(s.ts), at: s.ts };
    if (s.kind === 'preview' && tile?.minute.url) {
      const m = tile.minute;
      return { kind: 'tile', url: m.url, sx: (tile.index % m.cols) * m.tileW, sy: Math.floor(tile.index / m.cols) * m.tileH, w: m.tileW, h: m.tileH, at: s.ts };
    }
    return null;
  }
  $effect(() => registerPlayer({
    frame,
    fullscreen: () => {
      if (boxEl) void enterPlayerFullscreen(boxEl);
    },
  }));
  // Gone (another camera remounts the player): no fullscreen left behind.
  $effect(() => () => exitPlayerFullscreen());
  const mode = $derived(modeOf(glued));
  // REC adds what it shows (Klaus, 2026-10-04): SD or 4K for a clip, Still for the stills.
  const shown = $derived<RecShown | null>(source.kind === 'clip' ? clipShown(clipStream) : source.kind === 'still' ? 'Still' : null);
  const badge = $derived(mode === 'live' ? liveBadge($liveUi) : modeBadge(mode, at, now, shown));

  function toggle() {
    if (source.kind === 'future') return;
    playing = !playing;
  }
  // Not clamped to now: a clip may lie after it (a camera clock ahead), and
  // past now the panel says so and the ticker doesn't run.
  function skip(ms: number) {
    if (glued && ms > 0) return; // nothing after live
    seekNext = true;
    at = Math.max(0, at + ms);
  }
  // Space plays or pauses; ←/→ step 10 s, Shift+←/→ 1 s (spec: Player / Controls).
  function keydown(e: KeyboardEvent) {
    if ($playerFs !== 'off') return; // the overlay has the keys (on the window)
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Alt / Ctrl / Meta with an arrow are the browser's (Back / Forward).
      e.preventDefault();
      const ms = e.shiftKey ? 1000 : 10_000;
      skip(e.key === 'ArrowLeft' ? -ms : ms);
    }
  }
  // The fullscreen overlay's buttons, keys and gestures: false where
  // nothing happens (after now in live, nothing to play).
  function fsAction(a: FsAction): boolean {
    if (a.kind === 'skip') {
      if (glued && a.ms > 0) return false;
      skip(a.ms);
      return true;
    }
    if (a.kind === 'event') {
      if (glued && a.dir > 0) return false;
      return onstep(a.dir) === true;
    }
    if (a.kind === 'toggle') {
      if (glued || source.kind === 'future') return false;
      toggle();
      return true;
    }
    return false;
  }
  const triggers = $derived(source.kind === 'clip' ? orderTriggers(source.clip.triggers).map((t) => TRIGGER_LABELS[t]).join(', ') : '');
  // The date too: the strip crosses days (Klaus, 2026-09-28).
  const day = $derived.by(() => {
    const d = new Date(at);
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleDateString(undefined, { month: 'short' })} ${d.getDate()}`;
  });
  const ago = $derived(timeAgo(at, now));
  const clock = $derived(localClock(at));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="player" data-testid="strip-player" tabindex="0" onkeydown={keydown}>
  <div class="box" class:fill={$playerFs === 'fill'} bind:clientWidth={boxW} bind:this={boxEl}
    data-showing={glued ? 'live' : source.kind !== 'clip' ? 'pictures' : videoShown ? 'video' : 'cover'}>
    {#each [0, 1] as i (i)}
      <video
        bind:this={vids[i]}
        class:hidden={glued || source.kind !== 'clip' || i !== active}
        class:covered={i === active && covering}
        data-testid={i === active ? 'clip-video' : 'clip-video-idle'}
        src={srcs[i] ?? undefined}
        preload="auto"
        disableremoteplayback
        muted
        playsinline
        ontimeupdate={() => onVideoTime(i)}
        onended={() => onVideoEnded(i)}
        onerror={() => onVideoError(i)}
        onloadedmetadata={() => onMeta(i)}
        oncanplay={() => onCanPlay(i)}
        onseeked={() => onSeeked(i)}
        onloadeddata={() => framePresented(i)}
      ></video>
    {/each}
    {#if liveSnippet}
      <div class="layer" class:off={!glued} data-testid="strip-live">{@render liveSnippet()}</div>
    {/if}
    {#if glued}
      <!-- live: the layer above -->
    {:else if pic?.kind === 'still' && pendingTile}
      <div class="layer tile-wrap" data-testid="strip-preview">
        <span class="tile" style={`${tileStyle(pendingTile.minute, pendingTile.index, 1)};transform:scale(${boxW / 160})`}></span>
      </div>
    {:else if pic?.kind === 'still' && stillShown}
      <img class="layer" data-testid="strip-still" src={stillShown} alt="" />
    {:else if pic?.kind === 'preview' && tile}
      <div class="layer tile-wrap" data-testid="strip-preview">
        <span class="tile" style={`${tileStyle(tile.minute, tile.index, 1)};transform:scale(${boxW / 160})`}></span>
      </div>
    {:else if covering && stillShown}
      <!-- a clip with no still of its own yet: the last picture stays -->
      <img class="layer" data-testid="strip-still" src={stillShown} alt="" />
    {:else if source.kind === 'none' || source.kind === 'future'}
      <div class="layer empty" data-testid="strip-empty">
        <span>{source.kind === 'future' ? 'Later than now' : 'No recording'}</span>
        <small>{clock}</small>
      </div>
    {/if}
    <!-- The mode (spec 2026-10-04): ● LIVE, or REC and the time; REC is a
         button back to live. -->
    {#if glued}
      <span class="mode live" class:on={badge === '● LIVE'} data-testid="mode-badge" data-mode="live" role="status">{badge}</span>
    {:else}
      <button class="mode rec" data-testid="mode-badge" data-mode="rec" title="Back to live" aria-label={`${badge}, back to live`} onclick={() => onglue?.()}>{badge}</button>
    {/if}
    {#if $playerFs !== 'off'}
      <FullscreenOverlay {mode} {playing} kind={$playerFs} canPlay={source.kind !== 'future'} canPrev={stepAvail.prev} canNext={stepAvail.next} onaction={fsAction} onlive={() => onglue?.()} onexit={exitPlayerFullscreen} />
    {/if}
  </div>
  <div class="controls">
    <button data-testid="prev-clip" title="Previous event" onclick={() => onstep(-1)}><Icon name="prev" size={16} /></button>
    <!-- ⏮ << < ▶ > >> ⏭: 10 s and 1 s steps either side of play (Klaus, 2026-10-03). -->
    <button data-testid="back-10" title="Back 10 seconds" aria-label="Back 10 seconds" onclick={() => skip(-10_000)}><Icon name="back10" size={16} /></button>
    <button data-testid="back-1" title="Back 1 second" aria-label="Back 1 second" onclick={() => skip(-1000)}><Icon name="back1" size={16} /></button>
    <button data-testid="play-toggle" class="primary" aria-pressed={playing} title={playing ? 'Pause' : 'Play'} disabled={glued || source.kind === 'future'} onclick={toggle}>
      <Icon name={playing ? 'pause' : 'play'} size={16} />
    </button>
    <button data-testid="fwd-1" title={glued ? NOT_LIVE : 'Forward 1 second'} aria-label="Forward 1 second" disabled={glued} onclick={() => skip(1000)}><Icon name="fwd1" size={16} /></button>
    <button data-testid="fwd-10" title={glued ? NOT_LIVE : 'Forward 10 seconds'} aria-label="Forward 10 seconds" disabled={glued} onclick={() => skip(10_000)}><Icon name="fwd10" size={16} /></button>
    <button data-testid="next-clip" title={glued ? NOT_LIVE : 'Next event'} disabled={glued} onclick={() => onstep(1)}><Icon name="next" size={16} /></button>
    <!-- Time, source and why the clip was recorded, in one line (Klaus, 2026-09-28). -->
    <span class="info" data-testid="strip-info">
      {#if glued}
        <span class="live" class:stills={$liveUi.stillsShowing && $liveUi.playerState !== 'playing'} data-testid="live-badge">{$liveUi.badge}</span>
        · <span class="src" data-testid="source-badge">{liveSource}</span>
      {:else}
        <span class="time" data-testid="clip-time">{day}, {clock}</span>
        · <span data-testid="clip-ago">{ago}</span>
        · <span class="src" class:clip={source.kind === 'clip'} data-testid="source-badge">{BADGE[source.kind]}</span>
        {#if triggers}· <span data-testid="clip-triggers">{triggers}</span>{/if}
        {#if timelineHref}
          <!-- This moment in the Timeline: its minute opens with the still (Klaus, 2026-09-30). -->
          · <a data-testid="show-in-timeline" href={timelineHref}
            onclick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(timelineHref!); } }}>Show in Timeline</a>
        {/if}
      {/if}
    </span>
    <!-- Always there, off without a clip: it keeps its room, since its coming
         and going moved the strip under it (phone 2026-10-04, Pi 2026-10-05). -->
    <button class="dl" class:off={!downloadable} data-testid="clip-download" title="Download…" aria-label="Download this clip" aria-hidden={!downloadable} disabled={!downloadable}
      onclick={() => downloadable && (saving = downloadable)}><Icon name="downloads" size={16} /></button>
  </div>
</div>
{#if saving}
  <ComposeDialog camera={cam} clip={saving} composable={hasProxy} onclose={() => (saving = null)} />
{/if}

<style>
  .player { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .box { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; }
  video, .layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  video.hidden { visibility: hidden; }
  /* Loading or seeking under the still (2026-10-09): transparent, not
     display: none or visibility: hidden, so it decodes and presents frames. */
  video.covered { opacity: 0; }
  .layer.off { visibility: hidden; }
  /* Fullscreen (#182): the box is the whole screen, the browser's or, where
     there is none (iPhone), a fixed layer over the page ("fill the screen"). */
  .box:fullscreen { width: 100%; height: 100%; aspect-ratio: auto; border-radius: 0; }
  .box.fill {
    position: fixed; top: 0; left: 0; right: 0; z-index: 50;
    width: auto; height: 100vh; height: 100dvh; aspect-ratio: auto; border-radius: 0;
  }
  /* The live stream's own 16:9 stage fills the screen too, centred. */
  .box:fullscreen :global(.stage), .box.fill :global(.stage) { position: absolute; inset: 0; aspect-ratio: auto; border-radius: 0; }
  /* Live's connecting bar over stills: above the fullscreen controls. */
  .box:fullscreen, .box.fill { --live-connecting-bottom: calc(80px + env(safe-area-inset-bottom, 0px)); }
  .box.fill .mode { top: calc(8px + env(safe-area-inset-top, 0px)); right: calc(8px + env(safe-area-inset-right, 0px)); }
  :global(html.player-fill), :global(html.player-fill body) { overflow: hidden; background: var(--player-bg); }
  .live { color: var(--danger); font-weight: 600; }
  /* The mode badge: top right, clear of the stills badge (top left). */
  .mode {
    position: absolute; top: 8px; right: 8px; z-index: 4; padding: 3px 9px; border-radius: 7px; border: 0;
    font: inherit; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; font-variant-numeric: tabular-nums;
    background: var(--scrim); color: var(--on-grad);
  }
  .mode.live.on { background: var(--danger); }
  button.mode { cursor: pointer; }
  button.mode:hover { outline: 2px solid var(--accent); }
  /* Amber text: --warning-ink is for text on the amber badge, and alone it
     was white on white (light) or near black (dark). */
  .live.stills { color: var(--warning); }
  .tile-wrap { overflow: hidden; }
  .tile { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .empty { display: grid; place-content: center; gap: 4px; text-align: center; color: var(--muted); background: var(--strip-empty); }
  .info { font-size: 13px; color: var(--muted); }
  .info .time { font-family: var(--mono); }
  .info .src.clip { color: var(--accent); font-weight: 600; }
  .info a { color: var(--accent); }
  .controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .controls button, .dl { display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; text-decoration: none; }
  .controls button.primary { background: var(--grad); color: var(--on-grad); border: none; }
  .controls button:disabled { opacity: 0.5; cursor: default; }
  .time { font-family: var(--mono); font-size: 13px; color: var(--muted); }
  .dl { margin-left: auto; }
  /* The download button ends the player's button row and the info line takes
     its own line under it, at every width (the Pi's Chrome, 2026-10-05): in
     the info line, its 34 px box made that line taller with a clip than
     without, so the strip jumped; and kept hidden there, it made the page
     16 px taller and pushed it past a 720 px window. */
  .info { order: 1; flex-basis: 100%; }
  /* Hidden, not removed, at every width: its 34 px box is taller than the
     info line, so its coming and going moved the strip (phone 2026-10-04,
     the Pi's Chrome 2026-10-05). */
  .dl.off { visibility: hidden; }
  /* A phone (2026-10-04): the download button ends the button row and keeps
     its room without a clip, and the info line below it keeps two lines'
     room, so neither moves the strip when the source changes under a drag. */
  @media (max-width: 767px) {
    .info { order: 1; flex-basis: 100%; line-height: 18px; min-height: 36px; }
    /* Mixed fonts (the monospace time) on a baseline made a line 1 px taller. */
    .info span, .info a { vertical-align: top; }
  }
</style>
