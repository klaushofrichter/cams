<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import LivePlayer from './LivePlayer.svelte';
  import LiveStill from './LiveStill.svelte';
  import { cameras } from '../lib/stores';
  import { getJson } from '../lib/api';
  import { QUALITY_KEY, snapshotUrl } from '../lib/live';
  import type { PlayerState } from '../lib/liveSession';
  import { enterFullscreen } from '../lib/fullscreen';
  import { deriveStatus, liveStatus } from '../lib/liveStatus';
  import { badgeOf, liveUi, offlineReason, registerLiveActions, type CameraStatus } from '../lib/liveUi';

  // The live stream inside the player box (spec 2026-09-28). The video page
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

  // A request-sequence guard: a late /status answer for a camera switched
  // away from must not overwrite the newer camera's status.
  let statusRequest = 0;
  async function checkStatus(id: string) {
    const seq = ++statusRequest;
    liveUi.update((u) => ({ ...u, checking: true }));
    try {
      const result = await getJson<CameraStatus>(`/api/cameras/${encodeURIComponent(id)}/status`);
      if (seq === statusRequest) liveUi.update((u) => ({ ...u, status: result }));
    } catch {
      // The status request itself failed (network or cams down): that says
      // nothing about the camera, so it gets its own wording.
      if (seq === statusRequest) liveUi.update((u) => ({ ...u, status: { id, online: false, error: 'unreachable' } }));
    } finally {
      if (seq === statusRequest) liveUi.update((u) => ({ ...u, checking: false }));
    }
  }
  $effect(() => {
    const id = cameraId;
    // snapshotError belongs to the previous camera
    liveUi.update((u) => ({ ...u, status: null, snapshotError: '', playerState: 'connecting', stillsShowing: false, badge: badgeOf('connecting', false) }));
    void checkStatus(id);
  });

  function toggleQuality() {
    liveUi.update((u) => {
      const quality = u.quality === 'sub' ? 'main' : 'sub';
      try {
        localStorage.setItem(QUALITY_KEY, quality);
      } catch {
        // not persisted
      }
      return { ...u, quality };
    });
  }
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

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // Fetch first, then save: a plain download link would silently save an
  // error page (or nothing) when the camera can't take a snapshot.
  async function saveSnapshot() {
    const id = cameraId;
    liveUi.update((u) => ({ ...u, snapshotBusy: true, snapshotError: '' }));
    try {
      const res = await fetch(snapshotUrl(id), { credentials: 'same-origin' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${id}-${stamp()}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      liveUi.update((u) => ({ ...u, snapshotError: "The snapshot couldn't be taken. The camera may be busy or offline." }));
    } finally {
      liveUi.update((u) => ({ ...u, snapshotBusy: false }));
    }
  }

  onMount(() =>
    registerLiveActions({
      toggleMute: () => liveUi.update((u) => ({ ...u, muted: !u.muted })),
      toggleQuality,
      snapshot: () => void saveSnapshot(),
      fullscreen,
      retry: () => void checkStatus(cameraId),
    }),
  );

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
</div>

<style>
  .livebox { position: absolute; inset: 0; background: #000; }
  .livebox:fullscreen { background: #000; }
</style>
