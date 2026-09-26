<script lang="ts">
  import LivePlayer from '../components/LivePlayer.svelte';
  import Icon from '../components/Icon.svelte';
  import Timeline from '../components/Timeline.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { getJson } from '../lib/api';
  import { QUALITY_KEY, snapshotUrl, supportsHevc, type Quality } from '../lib/live';
  import type { PlayerState } from '../lib/liveSession';
  import { enterFullscreen } from '../lib/fullscreen';
  import { clipAtSecond, cursorSearch, eventsUrl, localDate, saveCursor, secondsIntoDay, type EventClip } from '../lib/recordings';
  import { navigate } from '../lib/router';
  import { pref } from '../lib/preferences';

  interface CameraStatus {
    id: string;
    online: boolean;
    model?: string;
    firmware?: string;
    error?: string;
  }

  const hevc = typeof MediaSource !== 'undefined' && supportsHevc((t) => MediaSource.isTypeSupported(t));

  function initialQuality(): Quality {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(QUALITY_KEY);
    } catch {
      // not available; fall back to the stored preference below
    }
    const wanted = stored ?? pref('liveQuality') ?? 'sub';
    return hevc && wanted === 'main' ? 'main' : 'sub';
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

  // A mini timeline of today's recordings, shown under the viewer once the
  // camera is confirmed online. Only fetched once `status` says online: an
  // offline camera's own Search call would otherwise just sit there until
  // it times out, for a timeline that has nothing to show anyway. A
  // request-sequence guard (like checkStatus above) drops a late response
  // from a camera that's since been switched away from.
  const today = localDate(new Date());
  let todayEvents: EventClip[] = $state([]);
  let eventsSeq = 0;
  $effect(() => {
    const id = $selectedCameraId;
    const online = status?.online === true;
    todayEvents = [];
    if (!id || !online) return;
    const seq = ++eventsSeq;
    getJson<{ events: EventClip[] }>(eventsUrl(id, today))
      .then((r) => {
        if (seq === eventsSeq) todayEvents = r.events;
      })
      .catch(() => {});
  });

  // Clicking (or arrow-stepping to) a point on the mini timeline opens the
  // full Recordings workspace at that clip.
  function openRecording(sec: number) {
    const id = $selectedCameraId;
    const e = clipAtSecond(todayEvents, today, sec);
    if (!id || !e) return;
    const c = { date: today, clipId: e.id, offsetSec: 0 };
    saveCursor(id, c);
    navigate(`/app/recordings${cursorSearch(id, c, 'history', 'all')}`);
  }

  // Nothing is ever "selected" on this mini timeline, so stepping and
  // jumping to an edge both mean the same thing: land on the first or last
  // recording of the day.
  function jumpToEdge(edge: 'start' | 'end') {
    if (!todayEvents.length) return;
    const target = edge === 'start' ? todayEvents[0] : todayEvents[todayEvents.length - 1];
    openRecording(secondsIntoDay(target.start, today));
  }
  function stepEvent(dir: -1 | 1) {
    jumpToEdge(dir === 1 ? 'start' : 'end');
  }

  function toggleQuality() {
    quality = quality === 'sub' ? 'main' : 'sub';
    try {
      localStorage.setItem(QUALITY_KEY, quality);
    } catch {
      // not persisted
    }
  }

  function fullscreen() {
    const video = container?.querySelector<HTMLVideoElement>('[data-testid="live-video"]') ?? null;
    void enterFullscreen(container, video);
  }

  // One explanation per error code: camera_error covers things re-trying
  // won't fix (a certificate problem, an unexpected answer), so it points at
  // the server logs instead of suggesting the camera is simply unreachable.
  function offlineReason(code: string | undefined): string {
    if (code === 'camera_offline') return 'The camera could not be reached.';
    if (code === 'camera_auth_failed') return 'Signing in to the camera failed.';
    return 'The camera answered with an error (for example a certificate problem). Check the server logs.';
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
      <span data-testid="offline-reason">{offlineReason(status.error)}</span>
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
      <div class="today">
        <span class="label">Today</span>
        {#if todayEvents.length}
          <Timeline events={todayEvents} date={today} selectedId={null} onpick={openRecording} onstep={stepEvent} onedge={jumpToEdge} compact testid="live-timeline" />
        {:else}
          <span class="none">No recordings yet today.</span>
        {/if}
      </div>
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
  .today { display: flex; flex-direction: column; gap: 4px; }
  .today .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .today .none { font-size: 13px; color: var(--muted); }
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
