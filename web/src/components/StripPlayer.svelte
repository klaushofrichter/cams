<!-- web/src/components/StripPlayer.svelte -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { nextChange, sourceAt, type Coverage, type Source } from '../lib/strip';
  import { downloadUrl, videoUrl } from '../lib/recordings';
  import { previewAt, tileStyle, type PreviewMinute } from '../lib/timeline';

  // History's player (spec 2026-09-27): one clock, `at`. A clip's <video>
  // drives it while a clip plays; otherwise a real-time ticker does, showing
  // stills, preview tiles or "No recording". Two <video> elements take turns
  // so the next clip is loaded 3 s before it starts.
  let {
    cam, coverage, previews, now, at = $bindable(), playing = $bindable(), unavailable = false, onclipfail, onstep,
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
  } = $props();

  const TICK_MS = 250;
  const PRELOAD_MS = 3000;
  const BADGE: Record<Source['kind'], string> = {
    clip: 'SD 10 FPS', still: 'Stills 1 FPS', preview: 'Preview 1 FPS', none: 'No recording', future: 'Live is on the Live page',
  };
  const stillUrl = (ts: number) => `/api/cameras/${encodeURIComponent(cam)}/stills/${ts}.jpg`;

  const source = $derived(sourceAt(coverage, at, now));

  // --- video A/B ---
  let vids: (HTMLVideoElement | undefined)[] = $state([undefined, undefined]);
  let srcs = $state<[string | null, string | null]>([null, null]);
  let active = $state(0);
  const failedOnce = new Set<string>();
  let followVideo = false; // true while the active video drives `at`

  function urlOf(id: string) {
    return videoUrl(cam, id);
  }
  // Put the clip in the active slot (swapping when the other slot preloaded it).
  $effect(() => {
    const s = source;
    if (s.kind !== 'clip') {
      followVideo = false;
      vids[active]?.pause();
      return;
    }
    const url = urlOf(s.clip.id);
    if (srcs[active] !== url) {
      if (srcs[1 - active] === url) active = 1 - active;
      else srcs[active] = url;
    }
    const v = vids[active];
    if (!v) return;
    const want = s.offsetMs / 1000;
    if (!followVideo || Math.abs((v.currentTime || 0) - want) > 1.5) {
      try {
        v.currentTime = want;
      } catch {
        // before metadata: applied on loadedmetadata below
      }
    }
    followVideo = true;
    if (playing) void v.play().catch(() => (playing = false));
    else v.pause();
  });
  // Preload the next clip into the idle slot 3 s ahead.
  $effect(() => {
    if (!playing) return;
    const next = nextChange(coverage, at, now);
    if (next === null || next - at > PRELOAD_MS) return;
    const s = sourceAt(coverage, next, now);
    if (s.kind === 'clip' && srcs[active] !== urlOf(s.clip.id)) srcs[1 - active] = urlOf(s.clip.id);
  });
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
  function onVideoError(i: number) {
    const s = source;
    if (i !== active || s.kind !== 'clip' || failedOnce.has(s.clip.id)) return;
    failedOnce.add(s.clip.id);
    onclipfail(s.clip.id);
  }
  function onMeta(i: number) {
    const s = source;
    if (i === active && s.kind === 'clip') vids[i]!.currentTime = s.offsetMs / 1000;
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

  // --- stills: shown once loaded; a failed one keeps the last good frame ---
  let stillShown = $state<string | null>(null);
  const loaded = new Set<string>();
  function loadStill(ts: number, show: boolean) {
    const url = stillUrl(ts);
    if (loaded.has(url)) {
      if (show) stillShown = url;
      return;
    }
    const img = new Image();
    img.onload = () => {
      loaded.add(url);
      if (show && source.kind === 'still' && stillUrl(source.ts) === url) stillShown = url;
    };
    img.src = url;
  }
  $effect(() => {
    const s = source;
    if (s.kind !== 'still') return;
    loadStill(s.ts, true);
    for (let k = 1; k <= 3; k++) loadStill(s.ts + k * 1000, false);
  });

  // --- preview tile, scaled up to the box ---
  let boxW = $state(0);
  const tile = $derived(source.kind === 'preview' ? previewAt(previews, source.ts) : null);

  function toggle() {
    if (source.kind === 'future') return;
    playing = !playing;
  }
  function skip(ms: number) {
    at = Math.min(now, Math.max(0, at + ms));
  }
  // Space plays or pauses; ←/→ step 10 s (spec: Player / Controls).
  function keydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      skip(e.key === 'ArrowLeft' ? -10_000 : 10_000);
    }
  }
  const clock = $derived(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="player" data-testid="strip-player" tabindex="0" onkeydown={keydown}>
  <div class="box" bind:clientWidth={boxW}>
    {#each [0, 1] as i (i)}
      <video
        bind:this={vids[i]}
        class:hidden={source.kind !== 'clip' || i !== active}
        data-testid={i === active ? 'clip-video' : 'clip-video-idle'}
        src={srcs[i] ?? undefined}
        preload="auto"
        playsinline
        ontimeupdate={() => onVideoTime(i)}
        onended={() => onVideoEnded(i)}
        onerror={() => onVideoError(i)}
        onloadedmetadata={() => onMeta(i)}
      ></video>
    {/each}
    {#if source.kind === 'still' && stillShown}
      <img class="layer" data-testid="strip-still" src={stillShown} alt="" />
    {:else if source.kind === 'preview' && tile}
      <div class="layer tile-wrap" data-testid="strip-preview">
        <span class="tile" style={`${tileStyle(tile.minute, tile.index, 1)};transform:scale(${boxW / 160})`}></span>
      </div>
    {:else if source.kind === 'none' || source.kind === 'future'}
      <div class="layer empty" data-testid="strip-empty">
        <span>{source.kind === 'future' ? 'Live is on the Live page' : 'No recording'}</span>
        <small>{clock}</small>
      </div>
    {/if}
    <span class="badge" class:clip={source.kind === 'clip'} data-testid="source-badge">{BADGE[source.kind]}</span>
  </div>
  <div class="controls">
    <button data-testid="prev-clip" title="Previous event" onclick={() => onstep(-1)}><Icon name="prev" size={16} /></button>
    <button data-testid="back-10" title="Back 10 seconds" onclick={() => skip(-10_000)}><Icon name="back10" size={16} /><span>10</span></button>
    <button data-testid="play-toggle" class="primary" aria-pressed={playing} title={playing ? 'Pause' : 'Play'} disabled={source.kind === 'future'} onclick={toggle}>
      <Icon name={playing ? 'pause' : 'play'} size={16} />
    </button>
    <button data-testid="fwd-10" title="Forward 10 seconds" onclick={() => skip(10_000)}><span>10</span><Icon name="fwd10" size={16} /></button>
    <button data-testid="next-clip" title="Next event" onclick={() => onstep(1)}><Icon name="next" size={16} /></button>
    <span class="time" data-testid="clip-time">{clock}</span>
    {#if source.kind === 'clip' && !unavailable}
      <a class="dl" data-testid="clip-download" href={downloadUrl(cam, source.clip.id, 'main')} title="Download (full quality)"><Icon name="downloads" size={16} /></a>
    {/if}
  </div>
</div>

<style>
  .player { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .box { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; }
  video, .layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  video.hidden { visibility: hidden; }
  .tile-wrap { overflow: hidden; }
  .tile { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .empty { display: grid; place-content: center; gap: 4px; text-align: center; color: var(--muted); background: var(--strip-empty); }
  .badge { position: absolute; top: 10px; left: 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; padding: 3px 9px; border-radius: 999px; background: var(--scrim); color: var(--on-grad); }
  .badge.clip { background: var(--accent); color: var(--accent-ink); }
  .controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .controls button, .dl { display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; text-decoration: none; }
  .controls button.primary { background: var(--grad); color: var(--on-grad); border: none; }
  .controls button:disabled { opacity: 0.5; cursor: default; }
  .time { font-family: var(--mono); font-size: 13px; color: var(--muted); }
  .dl { margin-left: auto; }
</style>
