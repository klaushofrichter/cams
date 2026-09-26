<script lang="ts">
  import { onDestroy } from 'svelte';
  import LivePlayer from '../components/LivePlayer.svelte';
  import Icon from '../components/Icon.svelte';
  import Timeline from '../components/Timeline.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { getJson } from '../lib/api';
  import { QUALITY_KEY, snapshotUrl, supportsHevc, type Quality } from '../lib/live';
  import type { PlayerState } from '../lib/liveSession';
  import { enterFullscreen } from '../lib/fullscreen';
  import { clipAtSecond, cursorSearch, eventsUrl, saveCursor, secondsIntoDay, type EventClip } from '../lib/recordings';
  import { navigate } from '../lib/router';
  import { pref } from '../lib/preferences';
  import { now } from '../lib/clock';
  import { createTodayRefresher, todayDate } from '../lib/refresh';
  import { deriveStatus, liveStatus } from '../lib/liveStatus';

  interface CameraStatus {
    id: string;
    online: boolean;
    model?: string;
    firmware?: string;
    error?: string;
  }

  // False while App keeps this page mounted but hidden (the keep-alive after
  // leaving Live). Things that would duplicate another page's test ids or
  // headings (the page title, the mini timeline) are only rendered while
  // visible; the player itself is never unmounted by this, so the stream
  // keeps playing in the background.
  // `audible` is false whenever nobody can hear it on purpose: another page
  // OR a hidden browser tab (Klaus: off-screen means either). `visible` only
  // covers the page, because a hidden tab still renders.
  let { visible = true, audible = true }: { visible?: boolean; audible?: boolean } = $props();

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
      // The status request itself failed (network or cams down): that says
      // nothing about the camera, so it gets its own wording.
      if (seq === statusRequest) status = { id, online: false, error: 'unreachable' };
    } finally {
      if (seq === statusRequest) checking = false;
    }
  }

  $effect(() => {
    const id = $selectedCameraId;
    status = null;
    snapshotError = ''; // belongs to the previous camera
    if (id) void checkStatus(id);
  });

  // A mini timeline of today's recordings, shown under the viewer once the
  // camera is confirmed online. Only fetched once `status` says online: an
  // offline camera's own Search call would otherwise just sit there until
  // it times out, for a timeline that has nothing to show anyway. A
  // request-sequence guard (like checkStatus above) drops a late response
  // from a camera that's since been switched away from.
  let todayEvents: EventClip[] = $state([]);
  let eventsSeq = 0;
  let refreshTick = $state(0);
  let updatedAt: Date | null = $state(null);
  let lastEventsKey = '';
  $effect(() => {
    const id = $selectedCameraId;
    const online = status?.online === true;
    void refreshTick;
    if (!id || !online) {
      todayEvents = [];
      lastEventsKey = '';
      return;
    }
    // Keyed by camera AND today's date: at local midnight this makes the
    // day rollover a fresh load (clearing yesterday's clips) rather than a
    // refresh, which would otherwise keep drawing yesterday's clips on top
    // of today's axis until the next poll happened to replace them.
    const key = `${id}|${$todayDate}`;
    const isRefresh = key === lastEventsKey;
    lastEventsKey = key;
    const seq = ++eventsSeq;
    if (!isRefresh) todayEvents = [];
    getJson<{ events: EventClip[] }>(eventsUrl(id, $todayDate))
      .then((r) => {
        if (seq !== eventsSeq) return;
        todayEvents = r.events;
        updatedAt = new Date();
      })
      .catch(() => {});
  });

  // Refreshes the mini timeline every minute while the tab is visible, and
  // once more when it becomes visible again. Skips the tick entirely while
  // this page itself is hidden (App keeps it mounted for the keep-alive
  // after leaving Live): nobody can see the mini timeline then, so there's
  // no point spending a Search call on the camera for it.
  $effect(() => {
    const r = createTodayRefresher({ isToday: () => true, refresh: () => { if (visible) refreshTick++; } });
    return () => r.stop();
  });

  // Coming back to Live (visible again after being hidden) refreshes once
  // at once, rather than waiting for the next minute's tick, so returning
  // shows whatever recorded while it was hidden. Starts `true`: App only
  // ever mounts this page while it's the visible one (see App.svelte), so
  // there's no "becoming visible" transition to catch on the very first
  // render -- and starting from the (reactive) `visible` prop directly here
  // would only capture its value once anyway, not track it.
  let wasVisible = true;
  $effect(() => {
    if (visible && !wasVisible) refreshTick++;
    wasVisible = visible;
  });

  // Clicking (or arrow-stepping to) a point on the mini timeline opens the
  // full Recordings workspace at that clip.
  function openRecording(sec: number) {
    const id = $selectedCameraId;
    const e = clipAtSecond(todayEvents, $todayDate, sec);
    if (!id || !e) return;
    const c = { date: $todayDate, clipId: e.id, offsetSec: 0 };
    saveCursor(id, c);
    navigate(`/app/recordings${cursorSearch(id, c, 'history', 'all')}`);
  }

  // Nothing is ever "selected" on this mini timeline, so stepping and
  // jumping to an edge both mean the same thing: land on the first or last
  // recording of the day.
  function jumpToEdge(edge: 'start' | 'end') {
    if (!todayEvents.length) return;
    const target = edge === 'start' ? todayEvents[0] : todayEvents[todayEvents.length - 1];
    openRecording(secondsIntoDay(target.start, $todayDate));
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

  // Leaving Live while its viewer is fullscreen (App keeps it mounted but
  // hidden, for the keep-alive) would otherwise leave a black fullscreen
  // screen behind: nothing in it is visible any more, but the browser is
  // still in fullscreen. Exit it as soon as this page is hidden.
  $effect(() => {
    if (!visible && container && document.fullscreenElement && container.contains(document.fullscreenElement)) {
      void document.exitFullscreen().catch(() => {});
    }
  });

  // One explanation per error code: camera_error covers things re-trying
  // won't fix (a certificate problem, an unexpected answer), so it points at
  // the server logs instead of suggesting the camera is simply unreachable.
  function offlineReason(code: string | undefined): string {
    if (code === 'camera_offline') return 'The camera could not be reached.';
    if (code === 'camera_auth_failed') return 'Signing in to the camera failed.';
    if (code === 'unreachable') return "cams couldn't check the camera (network or server problem).";
    return 'The camera answered with an error (for example a certificate problem). Check the server logs.';
  }

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  // Fetch first, then save: a plain download link would silently save an
  // error page (or nothing) when the camera can't take a snapshot.
  let snapshotBusy = $state(false);
  let snapshotError = $state('');
  async function saveSnapshot(id: string) {
    snapshotBusy = true;
    snapshotError = '';
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
      snapshotError = "The snapshot couldn't be taken. The camera may be busy or offline.";
    } finally {
      snapshotBusy = false;
    }
  }

  // Publishes the camera's live status (used for the favicon frame, the tab
  // title and the top-bar logo tooltip). Keep-alive (Task 12) keeps this page
  // mounted in the background after leaving Live, so the indicator stays
  // green while the stream keeps playing off-screen; onDestroy publishes idle
  // once the keep-alive expires and this page is actually torn down.
  $effect(() => {
    liveStatus.set(
      deriveStatus({
        mounted: true,
        cameraName: camera?.name ?? null,
        online: status ? status.online : null,
        offlineReason: status && !status.online ? offlineReason(status.error) : null,
        player: status?.online ? playerState : null,
      }),
    );
  });
  onDestroy(() => liveStatus.set(deriveStatus({ mounted: false, cameraName: null, online: null, offlineReason: null, player: null })));
</script>

<section class="page">
  <header class="head">
    {#if visible}<h1 data-testid="page-title">Live</h1>{/if}
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
      <!-- `muted` itself is left untouched while hidden, so the user's own
           choice comes back once Live is visible again; the player is muted
           here (not by mutating `muted`) so a hidden Live or a hidden tab
           playing in the background (the keep-alive) never plays audio
           nobody asked for. -->
      <LivePlayer cameraId={camera.id} {quality} muted={muted || !audible} onstate={(s) => (playerState = s)} />
      <div class="controls">
        <button data-testid="mute-toggle" aria-pressed={!muted} onclick={() => (muted = !muted)} title={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'volumeOff' : 'volumeOn'} size={18} /><span>{muted ? 'Muted' : 'Sound'}</span>
        </button>
        {#if hevc}
          <button data-testid="quality-toggle" aria-pressed={quality === 'main'} onclick={toggleQuality} title="Switch stream quality">
            {quality === 'main' ? 'HD' : 'SD'}
          </button>
        {/if}
        <button data-testid="snapshot" onclick={() => saveSnapshot(camera.id)} disabled={snapshotBusy} title="Save a snapshot">
          <Icon name="camera" size={18} /><span>{snapshotBusy ? 'Saving…' : 'Snapshot'}</span>
        </button>
        <button data-testid="fullscreen" onclick={fullscreen} title="Fullscreen"><Icon name="expand" size={18} /></button>
      </div>
      {#if snapshotError}<p class="snapshot-error" data-testid="snapshot-error" role="alert">{snapshotError}</p>{/if}
      <p class="meta">{status.model} · firmware {status.firmware}</p>
      <div class="today">
        {#if !visible}
          <!-- not rendered while hidden: its test ids would clash with Recordings' timeline -->
        {:else if todayEvents.length}
          <Timeline
            events={todayEvents}
            date={$todayDate}
            selectedId={null}
            onpick={openRecording}
            onstep={stepEvent}
            onedge={jumpToEdge}
            compact
            legend
            now={secondsIntoDay(new Date($now).toISOString(), $todayDate)}
            testid="live-timeline"
            {updatedAt}
          />
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
  .snapshot-error { margin: 0; font-size: 13px; color: var(--danger); }
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
