<script lang="ts">
  import LivePlayer from '../components/LivePlayer.svelte';
  import Icon from '../components/Icon.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { getJson } from '../lib/api';
  import { QUALITY_KEY, snapshotUrl, supportsHevc, type Quality } from '../lib/live';
  import type { PlayerState } from '../lib/liveSession';

  interface CameraStatus {
    id: string;
    online: boolean;
    model?: string;
    firmware?: string;
    error?: string;
  }

  const hevc = typeof MediaSource !== 'undefined' && supportsHevc((t) => MediaSource.isTypeSupported(t));

  function initialQuality(): Quality {
    try {
      return hevc && localStorage.getItem(QUALITY_KEY) === 'main' ? 'main' : 'sub';
    } catch {
      return 'sub';
    }
  }

  let quality: Quality = $state(initialQuality());
  let muted = $state(true);
  let playerState: PlayerState = $state('connecting');
  let status: CameraStatus | null = $state(null);
  let checking = $state(false);
  let container: HTMLDivElement | undefined = $state();
  let statusRequest = 0;

  const camera = $derived($cameras.find((c) => c.id === $selectedCameraId) ?? null);

  // A request-sequence guard: if the user switches cameras while an earlier
  // /status request is still in flight, its late response must not overwrite
  // the newer camera's status.
  async function checkStatus(id: string) {
    const seq = ++statusRequest;
    checking = true;
    try {
      const result = await getJson<CameraStatus>(`/api/cameras/${encodeURIComponent(id)}/status`);
      if (seq === statusRequest) status = result;
    } catch {
      if (seq === statusRequest) status = { id, online: false, error: 'camera_error' };
    } finally {
      if (seq === statusRequest) checking = false;
    }
  }

  $effect(() => {
    const id = $selectedCameraId;
    status = null;
    if (id) void checkStatus(id);
  });

  function toggleQuality() {
    quality = quality === 'sub' ? 'main' : 'sub';
    try {
      localStorage.setItem(QUALITY_KEY, quality);
    } catch {
      // not persisted
    }
  }

  function fullscreen() {
    void container?.requestFullscreen?.().catch(() => {});
  }

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
</script>

<section class="page">
  <header class="head">
    <h1 data-testid="page-title">Live</h1>
    {#if camera}<span class="cam">{camera.name}</span>{/if}
    {#if status?.online}
      <span class="badge" data-testid="live-badge" class:ok={playerState === 'playing'}>● {playerState === 'playing' ? 'LIVE' : '…'}</span>
      <span class="state" data-testid="live-state">
        {playerState === 'playing' ? 'Live' : playerState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </span>
    {/if}
  </header>

  {#if !camera}
    <div class="placeholder">No cameras are configured.</div>
  {:else if status && !status.online}
    <div class="offline" data-testid="offline-banner" role="alert">
      <strong>{camera.name} is offline.</strong>
      <span>The camera could not be reached{status.error === 'camera_auth_failed' ? ' (sign-in to the camera failed)' : ''}.</span>
      <button data-testid="retry" disabled={checking} onclick={() => checkStatus(camera.id)}>
        <Icon name="refresh" size={16} /> {checking ? 'Checking…' : 'Retry'}
      </button>
    </div>
  {:else if status?.online}
    <div class="viewer" bind:this={container}>
      <LivePlayer cameraId={camera.id} {quality} {muted} onstate={(s) => (playerState = s)} />
      <div class="controls">
        <button data-testid="mute-toggle" aria-pressed={!muted} onclick={() => (muted = !muted)} title={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'volumeOff' : 'volumeOn'} size={18} /><span>{muted ? 'Muted' : 'Sound'}</span>
        </button>
        {#if hevc}
          <button data-testid="quality-toggle" aria-pressed={quality === 'main'} onclick={toggleQuality} title="Switch stream quality">
            {quality === 'main' ? 'HD' : 'SD'}
          </button>
        {/if}
        <a data-testid="snapshot" href={snapshotUrl(camera.id)} download={`${camera.id}-${stamp()}.jpg`} title="Save a snapshot">
          <Icon name="camera" size={18} /><span>Snapshot</span>
        </a>
        <button data-testid="fullscreen" onclick={fullscreen} title="Fullscreen"><Icon name="expand" size={18} /></button>
      </div>
      <p class="meta">{status.model} · firmware {status.firmware}</p>
    </div>
  {:else}
    <div class="placeholder">Checking camera…</div>
  {/if}
</section>

<style>
  .head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .head h1 { margin: 0; }
  .cam { color: var(--muted); font-size: 15px; }
  .badge { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; padding: 3px 9px; border-radius: 999px; background: var(--surface-2); color: var(--muted); }
  .badge.ok { background: var(--danger); color: var(--on-grad); }
  .state { font-size: 13px; color: var(--muted); }
  .viewer { display: flex; flex-direction: column; gap: 10px; max-width: 1280px; }
  .viewer:fullscreen { max-width: none; background: #000; justify-content: center; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; }
  .controls button, .controls a {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 13px;
    text-decoration: none; cursor: pointer; transition: background-color 0.15s ease;
  }
  .controls button:hover, .controls a:hover { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .controls button[aria-pressed='true'] { border-color: var(--accent); }
  .meta { margin: 0; font-size: 12px; color: var(--muted); }
  .offline {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 16px 18px; border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }
  .offline button {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--surface-2); cursor: pointer;
  }
</style>
