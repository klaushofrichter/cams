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
  import { enterFullscreen } from '../lib/fullscreen';
  import { clipShown, liveBadge, modeBadge, modeOf, registerPlayer, type PlayerFrame, type RecShown } from '../lib/videoMode';

  // History's player (spec 2026-09-27): one clock, `at`. A clip's <video>
  // drives it while a clip plays; otherwise a real-time ticker does, showing
  // stills, preview tiles or "No recording". Two <video> elements take turns
  // so the next clip is loaded 3 s before it starts.
  let {
    cam, coverage, previews, now, at = $bindable(), playing = $bindable(), unavailable = false, onclipfail, onstep,
    glued = false, live: liveSnippet, onglue, clipStream = 'sub',
  }: {
    cam: string;
    coverage: Coverage;
    previews: PreviewMinute[];
    now: number;
    at: number;
    playing: boolean;
    unavailable?: boolean;
    onclipfail: (clipId: string) => void;
    onstep: (dir: -1 | 1) => void;
    glued?: boolean; // the Live panel's playhead is at now: show the live stream
    live?: Snippet; // the live stream; kept mounted while unglued so it resumes at once
    onglue?: () => void; // the REC badge: back to live (spec 2026-10-04)
    // The stream a clip's video plays: the clip route serves the sub stream
    // (SD) today; main (4K) when a player asks for it.
    clipStream?: 'sub' | 'main';
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
    if (u.playerState !== 'playing' && u.stillsShowing) return 'STILLS';
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
        if (vids[active]?.error) return failClip(s.clip.id);
        if (awaitingMeta[active]) {
          followVideo = false;
          return;
        }
      } else {
        // A new source resets the element's position to 0: don't follow it
        // until loadedmetadata has put it at the wanted offset.
        srcs[active] = url;
        awaitingMeta[active] = true;
        followVideo = false;
        return;
      }
    }
    const v = vids[active];
    if (!v || awaitingMeta[active]) return;
    const want = s.offsetMs / 1000;
    if (!followVideo || forced || Math.abs((v.currentTime || 0) - want) > 1.5) {
      try {
        v.currentTime = want;
      } catch {
        // before metadata: applied on loadedmetadata below
      }
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
      srcs[1 - active] = urlOf(s.clip.id);
      awaitingMeta[1 - active] = true;
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
    if (i !== active || s.kind !== 'clip' || !followVideo) return;
    const v = vids[i]!;
    at = Date.parse(s.clip.start) + v.currentTime * 1000;
  }
  function onVideoEnded(i: number) {
    const s = source;
    if (i !== active || s.kind !== 'clip') return;
    at = Date.parse(s.clip.end);
  }
  // Either slot: a preloaded clip that fails is failed before its turn.
  function onVideoError(i: number) {
    const id = srcs[i] ? idOf.get(srcs[i]!) : undefined;
    if (id) failClip(id);
  }
  function onMeta(i: number) {
    const s = source;
    awaitingMeta[i] = false;
    if (i !== active || s.kind !== 'clip' || srcs[i] !== urlOf(s.clip.id)) return;
    vids[i]!.currentTime = s.offsetMs / 1000;
    followVideo = true;
    if (playing) tryPlay(vids[i]!);
  }

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
      if (source.kind === 'still' && stillUrl(source.ts) === url) stillShown = url;
    };
    img.onerror = () => stillState.set(url, Date.now());
    img.src = url;
    // Keep the map to the last ten minutes or so of seconds.
    if (stillState.size > 700) for (const k of [...stillState.keys()].slice(0, 100)) stillState.delete(k);
  }
  const stillTs = $derived(source.kind === 'still' ? source.ts : null);
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
        stillPending = null;
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
  const tile = $derived(source.kind === 'preview' ? previewAt(previews, source.ts) : null);

  // The Video page's snapshot and fullscreen in a recording (spec
  // 2026-10-04): what is on screen, and the box to put in fullscreen. Live
  // has its own (the camera's snapshot, LiveBox's fullscreen).
  let boxEl: HTMLDivElement | undefined = $state();
  function frame(): PlayerFrame | null {
    if (glued) return null;
    const s = source;
    if (s.kind === 'clip') {
      const v = vids[active];
      return v ? { kind: 'clip', video: v, at } : null;
    }
    if (s.kind === 'still') return { kind: 'still', url: stillUrl(s.ts), at: s.ts };
    if (s.kind === 'preview' && tile?.minute.url) {
      const m = tile.minute;
      return { kind: 'tile', url: m.url, sx: (tile.index % m.cols) * m.tileW, sy: Math.floor(tile.index / m.cols) * m.tileH, w: m.tileW, h: m.tileH, at: s.ts };
    }
    return null;
  }
  $effect(() => registerPlayer({
    frame,
    fullscreen: () => void enterFullscreen(boxEl, source.kind === 'clip' ? (vids[active] ?? null) : null),
  }));
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
  <div class="box" bind:clientWidth={boxW} bind:this={boxEl}>
    {#each [0, 1] as i (i)}
      <video
        bind:this={vids[i]}
        class:hidden={glued || source.kind !== 'clip' || i !== active}
        data-testid={i === active ? 'clip-video' : 'clip-video-idle'}
        src={srcs[i] ?? undefined}
        preload="auto"
        muted
        playsinline
        ontimeupdate={() => onVideoTime(i)}
        onended={() => onVideoEnded(i)}
        onerror={() => onVideoError(i)}
        onloadedmetadata={() => onMeta(i)}
        oncanplay={() => onCanPlay(i)}
      ></video>
    {/each}
    {#if liveSnippet}
      <div class="layer" class:off={!glued} data-testid="strip-live">{@render liveSnippet()}</div>
    {/if}
    {#if glued}
      <!-- live: the layer above -->
    {:else if source.kind === 'still' && pendingTile}
      <div class="layer tile-wrap" data-testid="strip-preview">
        <span class="tile" style={`${tileStyle(pendingTile.minute, pendingTile.index, 1)};transform:scale(${boxW / 160})`}></span>
      </div>
    {:else if source.kind === 'still' && stillShown}
      <img class="layer" data-testid="strip-still" src={stillShown} alt="" />
    {:else if source.kind === 'preview' && tile}
      <div class="layer tile-wrap" data-testid="strip-preview">
        <span class="tile" style={`${tileStyle(tile.minute, tile.index, 1)};transform:scale(${boxW / 160})`}></span>
      </div>
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
    <!-- Always there, off without a clip: on a phone it keeps its room, since
         its coming and going moved the strip under it (2026-10-04). -->
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
  .layer.off { visibility: hidden; }
  .live { color: var(--danger); font-weight: 600; }
  /* The mode badge: top right, clear of the stills badge (top left). */
  .mode {
    position: absolute; top: 8px; right: 8px; z-index: 2; padding: 3px 9px; border-radius: 7px; border: 0;
    font: inherit; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; font-variant-numeric: tabular-nums;
    background: var(--scrim); color: var(--on-grad);
  }
  .mode.live.on { background: var(--danger); }
  button.mode { cursor: pointer; }
  button.mode:hover { outline: 2px solid var(--accent); }
  .live.stills { color: var(--warning-ink); }
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
  .dl.off { display: none; } /* a desktop: as before */
  /* A phone (2026-10-04): the download button ends the button row and keeps
     its room without a clip, and the info line below it keeps two lines'
     room, so neither moves the strip when the source changes under a drag. */
  @media (max-width: 767px) {
    .info { order: 1; flex-basis: 100%; line-height: 18px; min-height: 36px; }
    /* Mixed fonts (the monospace time) on a baseline made a line 1 px taller. */
    .info span, .info a { vertical-align: top; }
    .dl.off { display: inline-flex; visibility: hidden; }
  }
</style>
