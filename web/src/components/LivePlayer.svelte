<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { LiveSession, type PlayerState } from '../lib/liveSession';
  import { liveUrl, type Quality } from '../lib/live';
  import { mpegtsPlayer } from '../lib/mpegtsPlayer';
  import { whenPainted } from '../lib/liveConnectStill';

  let {
    cameraId,
    quality,
    muted,
    onstate,
  }: { cameraId: string; quality: Quality; muted: boolean; onstate: (s: PlayerState) => void } = $props();

  let videoA: HTMLVideoElement | undefined = $state();
  let videoB: HTMLVideoElement | undefined = $state();
  let active: 0 | 1 = $state(0);
  let session: LiveSession | null = null;

  // Review focus 4: a change of camera or quality tears the old session down
  // before the new one starts.
  $effect(() => {
    const url = liveUrl(cameraId, quality);
    if (!videoA || !videoB) return;
    // untrack: a parent re-creating its callback must not restart the stream.
    const report = untrack(() => onstate);
    const videos: [HTMLVideoElement, HTMLVideoElement] = [videoA, videoB];
    session?.stop();
    active = 0;
    // "playing" once the first frame is on screen (Klaus, 2026-10-06): the
    // still shown while connecting stays until then, so no black flash.
    let cancelPaint: (() => void) | null = null;
    const onState = (s: PlayerState) => {
      cancelPaint?.();
      cancelPaint = null;
      if (s !== 'playing') return report(s);
      cancelPaint = whenPainted(videos[untrack(() => active)], () => {
        cancelPaint = null;
        report('playing');
      });
    };
    session = new LiveSession(videos, url, mpegtsPlayer, onState, (i) => (active = i));
    session.start();
    return () => {
      cancelPaint?.();
      cancelPaint = null;
      session?.stop();
      session = null;
    };
  });

  onDestroy(() => session?.stop());
</script>

<div class="stage">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={videoA} class:on={active === 0} data-testid={active === 0 ? 'live-video' : undefined} {muted} playsinline autoplay disableremoteplayback></video>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={videoB} class:on={active === 1} data-testid={active === 1 ? 'live-video' : undefined} {muted} playsinline autoplay disableremoteplayback></video>
</div>

<style>
  .stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 0.2s ease; }
  video.on { opacity: 1; }
</style>
