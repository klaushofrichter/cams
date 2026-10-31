<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { LiveSession, type PlayerState } from '../lib/liveSession';
  import { browserCodecs, liveUrl, type Quality } from '../lib/live';
  import { mpegtsPlayer } from '../lib/mpegtsPlayer';
  import { fmp4Player } from '../lib/fmp4Player';
  import { cameras } from '../lib/stores';
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

  // A camera behind an up-to-date cam-proxy plays the proxy's fMP4 (MSE);
  // others the camera's FLV through mpegts.js, as before.
  const throughProxy = $derived(!!$cameras.find((c) => c.id === cameraId)?.throughProxy);
  // The codecs this browser can play of the proxy's fMP4 (iPhone Safari has only ManagedMediaSource).
  const Source = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? globalThis.MediaSource;
  const codecs = $derived(throughProxy ? browserCodecs((t: string) => !!Source?.isTypeSupported?.(t)) : '');
  // None of them: say so instead of retrying a stream that can't play.
  const unsupported = $derived(throughProxy && codecs === '');

  // Review focus 4: a change of camera or quality tears the old session down
  // before the new one starts.
  $effect(() => {
    const viaProxy = throughProxy;
    const url = viaProxy ? liveUrl(cameraId, quality, codecs) : liveUrl(cameraId, quality);
    if (!videoA || !videoB || unsupported) return;
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
    session = new LiveSession(videos, url, viaProxy ? fmp4Player : mpegtsPlayer, onState, (i) => (active = i));
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
  {#if unsupported}<p class="unsupported" data-testid="live-unsupported">This browser can't play this camera's video format.</p>{/if}
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={videoA} class:on={active === 0} data-testid={active === 0 ? 'live-video' : undefined} {muted} playsinline autoplay disableremoteplayback></video>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={videoB} class:on={active === 1} data-testid={active === 1 ? 'live-video' : undefined} {muted} playsinline autoplay disableremoteplayback></video>
</div>

<style>
  .stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 0.2s ease; }
  video.on { opacity: 1; }
  .unsupported { position: absolute; inset: 0; z-index: 1; display: grid; place-items: center; margin: 0; padding: 16px; text-align: center; color: var(--muted); }
</style>
