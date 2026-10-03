<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import LivePlayer from './LivePlayer.svelte';
  import LiveStill from './LiveStill.svelte';
  import LiveConnecting from './LiveConnecting.svelte';
  import { cameras } from '../lib/stores';
  import type { PlayerState } from '../lib/liveSession';
  import { enterFullscreen } from '../lib/fullscreen';
  import { deriveStatus, liveStatus } from '../lib/liveStatus';
  import { badgeOf, liveUi, offlineReason, registerLiveFullscreen } from '../lib/liveUi';

  // The live stream inside the player box (spec 2026-09-28). The camera's
  // status comes from the page (checkLiveStatus), so the Live panel works
  // without the stream. The video page
  // keeps it mounted while the stream is kept alive, hidden when unglued or
  // on another page; `visible` says whether it is on screen, `audible`
  // whether anybody can hear it (another page or a hidden tab: no).
  let { cameraId, visible, audible, proxy }: { cameraId: string; visible: boolean; audible: boolean; proxy: boolean } = $props();

  let box: HTMLDivElement | undefined = $state();
  const camera = $derived($cameras.find((c) => c.id === cameraId) ?? null);
  // Narrowed: LivePlayer restarts its stream when these change, and reading
  // the whole store in its props would restart it on every state report.
  const quality = $derived($liveUi.quality);
  const muted = $derived($liveUi.muted || !audible);

  function setState(s: PlayerState) {
    liveUi.update((u) => ({ ...u, playerState: s, badge: badgeOf(s, u.stillsShowing) }));
  }
  function setStills(on: boolean) {
    liveUi.update((u) => ({ ...u, stillsShowing: on, badge: badgeOf(u.playerState, on) }));
  }

  // Live video not playing for 5 s (connecting or reconnecting): a camera
  // with a cam-proxy shows its stills meanwhile.
  let stuck = $state(false);
  const playerState = $derived($liveUi.playerState); // not every liveUi change: that would restart the 5 s
  $effect(() => {
    void cameraId; // a camera switch starts over
    stuck = false;
    if (playerState === 'playing') return;
    const t = setTimeout(() => (stuck = true), 5000);
    return () => clearTimeout(t);
  });

  // The connecting indicator: until the stream plays, unless the camera is
  // known offline (that has its own message). A stream kept alive is already
  // playing when Live comes back, so it shows nothing then. LiveSession has
  // no give-up state: it retries with backoff for as long as Live is open.
  const connecting = $derived($liveUi.status?.online !== false && playerState !== 'playing');

  function fullscreen() {
    const video = box?.querySelector<HTMLVideoElement>('[data-testid="live-video"]') ?? null;
    void enterFullscreen(box, video);
  }
  // Leaving the live view while it's fullscreen would leave a black
  // fullscreen screen behind: exit it as soon as the stream is off screen.
  $effect(() => {
    if (!visible && box && document.fullscreenElement && box.contains(document.fullscreenElement)) {
      void document.exitFullscreen().catch(() => {});
    }
  });

  onMount(() => registerLiveFullscreen(fullscreen));
  // Closing the stream leaves no player state behind for the Live panel.
  onDestroy(() => liveUi.update((u) => ({ ...u, playerState: 'connecting', stillsShowing: false, badge: badgeOf('connecting', false) })));

  // The camera's live status (favicon frame, tab title, logo tooltip). The
  // box stays mounted while the stream is kept alive, so the indicator stays
  // green meanwhile; onDestroy publishes idle once it is torn down.
  $effect(() => {
    const status = $liveUi.status;
    liveStatus.set(
      deriveStatus({
        mounted: true,
        cameraName: camera?.name ?? null,
        online: status ? status.online : null,
        offlineReason: status && !status.online ? offlineReason(status.error) : null,
        player: status?.online ? $liveUi.playerState : null,
      }),
    );
  });
  onDestroy(() => liveStatus.set(deriveStatus({ mounted: false, cameraName: null, online: null, offlineReason: null, player: null })));
</script>

<div class="livebox" bind:this={box}>
  {#if $liveUi.status?.online}
    <!-- Muted here, not by changing `muted`, so the user's choice comes back
         once it is on screen again. -->
    <LivePlayer {cameraId} {quality} {muted} onstate={(s) => setState(s)} />
    {#if proxy && stuck}<LiveStill {cameraId} active={visible} overlay onactive={(on) => setStills(on)} />{/if}
  {:else if $liveUi.status && !$liveUi.status.online && proxy}
    <LiveStill {cameraId} active={visible} onactive={(on) => setStills(on)} />
  {/if}
  {#if connecting}
    <LiveConnecting reconnecting={playerState === 'reconnecting'} stills={$liveUi.stillsShowing} />
  {/if}
</div>

<style>
  .livebox { position: absolute; inset: 0; background: #000; }
  .livebox:fullscreen { background: #000; }
</style>
