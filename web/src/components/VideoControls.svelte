<script lang="ts">
  import Icon from './Icon.svelte';
  import { liveFullscreen, liveUi, saveSnapshot, toggleMute, toggleQuality } from '../lib/liveUi';
  import { getJson } from '../lib/api';
  import { putJson } from '../lib/settings';
  import { LIVE_ONLY, saveRecordingSnapshot, type Mode } from '../lib/videoMode';

  // The Video page's controls (spec 2026-10-04): sound, quality, light,
  // snapshot, fullscreen. Quality and light act on the live stream, so they
  // are off in a recording ("Only in live mode"); so is fullscreen, which
  // works for live only (Klaus, 2026-10-04; a recording's is an issue). The snapshot is the
  // camera's full picture live, and the frame on screen in a recording.
  let { cameraId, mode, paused = false }: {
    cameraId: string;
    mode: Mode;
    paused?: boolean; // the page or the tab is hidden: the light isn't asked for
  } = $props();

  const live = $derived(mode === 'live');
  const online = $derived($liveUi.status?.id === cameraId && !!$liveUi.status.online);

  // The camera's manual light (WhiteLed.state): read when the card shows and
  // every 30 s (not while hidden), so a change from the Reolink app shows
  // too. No button when the camera can't say (no light, an error).
  let light = $state<boolean | null>(null);
  let lightInFlight = 0; // PUTs not answered yet: the poll doesn't overwrite them
  // The camera takes a while. After a click the button waits for the new
  // state, 2 s at most, so a double click doesn't switch it back (Klaus, 2026-09-29).
  const LIGHT_HOLD_MS = 2000;
  let lightWant = $state<boolean | null>(null);
  let lightHold = $state(false);
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const lightBusy = $derived(lightHold && light !== lightWant);
  $effect(() => () => clearTimeout(holdTimer));
  $effect(() => {
    const id = cameraId;
    if (!online || paused) return;
    let stale = false;
    const read = () =>
      getJson<{ on: boolean }>(`/api/cameras/${encodeURIComponent(id)}/light`).then(
        (r) => { if (!stale && !lightInFlight) light = r.on; },
        () => { if (!stale) light = null; },
      );
    void read();
    const t = setInterval(read, 30_000);
    return () => {
      stale = true;
      clearInterval(t);
      light = null;
    };
  });
  async function toggleLight() {
    if (light === null || lightBusy || !live) return;
    const want = !light;
    lightWant = want;
    lightHold = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => (lightHold = false), LIGHT_HOLD_MS);
    lightInFlight++;
    try {
      const r = await putJson<{ on?: boolean }>(`/api/cameras/${encodeURIComponent(cameraId)}/light`, { on: want });
      if (typeof r.body.on === 'boolean') light = r.body.on;
    } catch {
      // keep the last known state
    } finally {
      lightInFlight--;
    }
  }
  // A click on quality, light or fullscreen in a recording does nothing but say why, on
  // screen: a phone shows no tooltip (review of #173).
  let noteShown = $state(false);
  $effect(() => {
    if (live) noteShown = false;
  });
  function liveOnly(action: () => void) {
    if (live) action();
    else noteShown = true;
  }
  function snapshot() {
    void (live ? saveSnapshot(cameraId) : saveRecordingSnapshot(cameraId));
  }
  const fullscreenName = $derived(live ? 'Fullscreen' : 'Fullscreen — only in live mode');
  const muteTip = $derived($liveUi.muted ? 'Muted, click to unmute' : 'Sound on, click to mute');
  const lightTip = $derived(!live ? LIVE_ONLY : light ? 'Light is on, click to turn off' : 'Light is off, click to turn on');
  const qualityTip = $derived(!live ? LIVE_ONLY : $liveUi.quality === 'main' ? 'Switch to SD' : 'Switch to 4K');
  const qualityName = $derived(!live ? 'Quality — only in live mode' : `Quality: ${$liveUi.quality === 'main' ? '4K, switch to SD' : 'SD, switch to 4K'}`);
  const lightName = $derived(!live ? 'Light — only in live mode' : lightTip);
  const snapTip = $derived($liveUi.snapshotBusy ? 'Saving…' : live ? 'Save a snapshot' : 'Save this frame');
</script>

<section class="tile controls" data-testid="live-controls" data-mode={mode}>
  <!-- Icons only, the tooltips explain them (Klaus, 2026-09-29). -->
  <button data-testid="mute-toggle" aria-pressed={!$liveUi.muted} onclick={() => toggleMute()} title={muteTip} aria-label={muteTip}>
    <Icon name={$liveUi.muted ? 'volumeOff' : 'volumeOn'} size={18} />
  </button>
  {#if $liveUi.hevc}
    <button data-testid="quality-toggle" aria-pressed={$liveUi.quality === 'main'} aria-disabled={live ? undefined : 'true'} aria-describedby={live ? undefined : 'live-only-note'}
      onclick={() => liveOnly(toggleQuality)} title={qualityTip} aria-label={qualityName}>
      {$liveUi.quality === 'main' ? '4K' : 'SD'}
    </button>
  {/if}
  {#if light !== null}
    <button data-testid="light-toggle" aria-pressed={light} disabled={live && lightBusy} aria-disabled={live ? undefined : 'true'} aria-describedby={live ? undefined : 'live-only-note'}
      onclick={() => liveOnly(toggleLight)} title={lightTip} aria-label={lightName}>
      <Icon name={light ? 'lightOn' : 'light'} size={18} />
    </button>
  {/if}
  <button data-testid="snapshot" onclick={snapshot} disabled={$liveUi.snapshotBusy} title={snapTip} aria-label={snapTip}>
    <Icon name="camera" size={18} />
  </button>
  <button data-testid="fullscreen" aria-disabled={live ? undefined : 'true'} aria-describedby={live ? undefined : 'live-only-note'}
    onclick={() => liveOnly(liveFullscreen)} title={live ? 'Fullscreen' : LIVE_ONLY} aria-label={fullscreenName}><Icon name="expand" size={18} /></button>
  <!-- In a recording: what aria-describedby reads; on screen once clicked. -->
  {#if !live}<p class="note" class:sr-only={!noteShown} id="live-only-note" data-testid="live-only-note" data-shown={noteShown} role="status">Quality, light and fullscreen work only in live mode.</p>{/if}
  {#if $liveUi.snapshotError}<p class="snapshot-error" data-testid="snapshot-error" role="alert">{$liveUi.snapshotError}</p>{/if}
</section>

<style>
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
  .controls { display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px; }
  .controls button {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 13px; cursor: pointer;
  }
  .controls button:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .controls button[aria-pressed='true'] { border-color: var(--accent); }
  /* Disabled buttons keep their tooltip: it says why ("Only in live mode"). */
  .controls button:disabled, .controls button[aria-disabled='true'] { opacity: 0.45; cursor: not-allowed; }
  .controls button[aria-disabled='true']:hover { background: var(--surface-2); }
  .note { margin: 0; width: 100%; font-size: 13px; color: var(--muted); }
  /* After .note: its width must not undo the hiding (it overflowed the page). */
  .note.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .snapshot-error { margin: 0; width: 100%; font-size: 13px; color: var(--danger); }
</style>
