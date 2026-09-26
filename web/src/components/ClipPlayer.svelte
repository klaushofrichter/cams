<script lang="ts">
  import Icon from './Icon.svelte';

  let {
    src,
    startAt = 0,
    hasPrev,
    hasNext,
    onprev,
    onnext,
    onauto,
    ontime,
    downloadHref,
  }: {
    src: string | null;
    startAt?: number;
    hasPrev: boolean;
    hasNext: boolean;
    onprev: () => void;
    onnext: () => void;
    onauto?: () => void;
    ontime: (sec: number) => void;
    downloadHref: string | null;
  } = $props();

  let video: HTMLVideoElement | undefined = $state();
  let playing = $state(false);
  let current = $state(0);
  let loadedSrc: string | null = null;
  let appliedStart = 0;
  // Lives outside the effect (rather than being created fresh on every run)
  // so a seek that arrives before metadata has loaded can replace the
  // pending listener instead of racing it.
  let controller: AbortController | null = null;

  // Arms a one-shot 'loadedmetadata' listener that seeks to `at` (and, when
  // `autoplay`, starts playback). Aborts whatever listener was previously
  // pending first, so re-arming (a fresh seek before metadata has loaded)
  // supersedes it rather than racing it.
  function armMetadataSeek(v: HTMLVideoElement, at: number, autoplay: boolean) {
    controller?.abort();
    controller = new AbortController();
    v.addEventListener(
      'loadedmetadata',
      () => {
        if (at > 0 && at < v.duration) v.currentTime = at;
        if (autoplay) void v.play().catch(() => (playing = false));
      },
      { once: true, signal: controller.signal },
    );
  }

  // Handles the src cycling through A -> null -> A (a video element is
  // destroyed and recreated when the player is hidden and shown again): the
  // null branch resets loadedSrc so the same src is treated as unloaded on
  // the new element, instead of being skipped as "already loaded".
  $effect(() => {
    if (!src) {
      loadedSrc = null;
      current = 0;
      playing = false;
      controller?.abort();
      controller = null;
      return;
    }
    if (!video) {
      loadedSrc = null;
      return;
    }
    if (src === loadedSrc) {
      // A timeline click within the clip that's already playing: seek
      // without reloading the source.
      if (startAt !== appliedStart) {
        appliedStart = startAt;
        if (video.readyState < 1) {
          // Metadata hasn't loaded yet: setting currentTime now would be
          // silently ignored, and the load branch's own pending listener
          // would otherwise apply its stale target once metadata arrives.
          // Re-arm with the latest target instead.
          armMetadataSeek(video, startAt, false);
        } else {
          video.currentTime = startAt;
        }
      }
      return;
    }
    loadedSrc = src;
    appliedStart = startAt;
    current = 0;
    playing = false;
    const v = video;
    v.src = src;
    armMetadataSeek(v, startAt, true);
  });

  // Exposed so the page can seek a clip that's already loaded even when the
  // computed second is identical to the last one (the URL then doesn't
  // change, so the startAt prop wouldn't otherwise re-trigger a seek).
  export function seek(sec: number) {
    if (!video) return;
    appliedStart = sec;
    if (video.readyState < 1) armMetadataSeek(video, sec, false);
    else video.currentTime = sec;
  }

  function toggle() {
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }
  function skip(d: number) {
    if (video) video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + d));
  }
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
</script>

<div class="player">
  {#if src}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={video}
      data-testid="clip-video"
      playsinline
      muted
      onplay={() => (playing = true)}
      onpause={() => (playing = false)}
      ontimeupdate={() => {
        current = video?.currentTime ?? 0;
        ontime(current);
      }}
      onended={() => hasNext && (onauto ?? onnext)()}
    ></video>
  {:else}
    <div class="empty">Select a recording on the timeline or in the list.</div>
  {/if}
  <div class="controls">
    <button data-testid="prev-clip" disabled={!hasPrev} onclick={onprev} title="Previous recording"><Icon name="prev" size={16} /></button>
    <button data-testid="back-10" disabled={!src} onclick={() => skip(-10)} title="Back 10 seconds"><Icon name="back10" size={16} /><span>10</span></button>
    <button data-testid="play-toggle" class="primary" disabled={!src} onclick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
      <Icon name={playing ? 'pause' : 'play'} size={18} />
    </button>
    <button data-testid="fwd-10" disabled={!src} onclick={() => skip(10)} title="Forward 10 seconds"><span>10</span><Icon name="fwd10" size={16} /></button>
    <button data-testid="next-clip" disabled={!hasNext} onclick={onnext} title="Next recording"><Icon name="next" size={16} /></button>
    <span class="time" data-testid="clip-time">{clock(current)}</span>
    {#if downloadHref}<a class="dl" href={downloadHref} download title="Download (full quality)"><Icon name="downloads" size={16} /></a>{/if}
  </div>
</div>

<style>
  .player { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  video, .empty { width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; }
  .empty { display: grid; place-items: center; color: var(--muted); background: var(--surface); border: 1px dashed var(--border); padding: 12px; text-align: center; }
  .controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  button, .dl {
    display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 10px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 12px; cursor: pointer;
    transition: background-color 0.15s ease;
  }
  button:disabled { opacity: 0.4; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .time { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-left: 4px; }
  .dl { margin-left: auto; }
</style>
