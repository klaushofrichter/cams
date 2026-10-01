<script lang="ts">
  import { openProxyClick } from '../lib/proxyLink';
  import Icon from './Icon.svelte';
  import VisionBadges from './VisionBadges.svelte';
  import { badges } from '../lib/vision';
  import { checkLiveStatus, liveFullscreen, liveUi, offlineReason, saveSnapshot, toggleMute, toggleQuality, type StreamInfo } from '../lib/liveUi';
  import { formatClock, orderTriggers, thumbUrl, TRIGGER_LABELS, type EventClip } from '../lib/recordings';
  import { timeAgo } from '../lib/clock';
  import type { CameraSummary } from '../lib/stores';
  import { groupPending, type Pending } from '../lib/eventStream';
  import { getJson } from '../lib/api';
  import { putJson } from '../lib/settings';

  // The Live panel (spec 2026-09-28): the camera, its recent events and the
  // live controls, beside the player column. The stream itself is LiveBox's.
  let { camera, recent, pending, onplay, proxyInfo, paused = false }: {
    camera: CameraSummary;
    recent: EventClip[]; // today's events, newest first
    pending: Pending[];
    onplay: (e: EventClip) => void;
    proxyInfo: { reachable: boolean; webUrl: string | null } | null;
    paused?: boolean; // the stream isn't open: the tab is hidden
  } = $props();

  const status = $derived($liveUi.status);
  const stream = (label: string, s: StreamInfo | null | undefined) =>
    s ? `${label} ${s.codec === 'h265' ? 'H.265' : 'H.264'} ${s.width}×${s.height} @${s.fps}` : null;
  const streams = $derived([stream('Main', status?.streams?.main), stream('Sub', status?.streams?.sub)].filter(Boolean).join(' · '));

  // "12 minutes ago", kept current.
  let nowMs = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (nowMs = Date.now()), 30_000);
    return () => clearInterval(id);
  });
  // Up to five, newest on top; recordings still in progress first (Klaus,
  // 2026-09-29), one row per recording (2026-09-30).
  const MAX_RECENT = 5;
  const pendingShown = $derived(groupPending(pending).slice(0, MAX_RECENT));
  const recentShown = $derived(recent.slice(0, MAX_RECENT - pendingShown.length));

  // The camera's manual light (WhiteLed.state): read when the panel opens and
  // every 30 s (not while the tab is hidden), so a change from the Reolink
  // app shows too. No button when the camera can't say (no light, an error).
  let light = $state<boolean | null>(null);
  let lightInFlight = 0; // PUTs not answered yet: the poll doesn't overwrite them
  // The camera takes a while. After a click the button waits for the new
  // state, 2 s at most, so a double click doesn't switch it back (Klaus, 2026-09-29).
  const LIGHT_HOLD_MS = 2000;
  let lightWant = $state<boolean | null>(null);
  let lightHold = $state(false);
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const lightDisabled = $derived(lightHold && light !== lightWant);
  $effect(() => () => clearTimeout(holdTimer));
  const online = $derived(!!status?.online);
  $effect(() => {
    const id = camera.id;
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
    if (light === null || lightDisabled) return;
    const want = !light;
    lightWant = want;
    lightHold = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => (lightHold = false), LIGHT_HOLD_MS);
    lightInFlight++;
    try {
      const r = await putJson<{ on?: boolean }>(`/api/cameras/${encodeURIComponent(camera.id)}/light`, { on: want });
      if (typeof r.body.on === 'boolean') light = r.body.on;
    } catch {
      // keep the last known state
    } finally {
      lightInFlight--;
    }
  }
  const muteTip = $derived($liveUi.muted ? 'Muted, click to unmute' : 'Sound on, click to mute');
  const lightTip = $derived(light ? 'Light is on, click to turn off' : 'Light is off, click to turn on');
  const label = (kind: string) => TRIGGER_LABELS[kind as keyof typeof TRIGGER_LABELS] ?? kind;
</script>

<div class="panel" data-testid="live-panel">
  <section class="tile">
    <h2 data-testid="live-camera-name">{camera.name}</h2>
    <span class="kind"><span data-testid="live-camera-kind">{status?.simulator ? 'Simulated camera' : 'Camera'}</span>{#if status?.simulator}
      <small class="meta" data-testid="live-camera-simulator">{status.simulator}</small>{/if}</span>
    {#if status?.model}<span class="meta" data-testid="live-camera-model">{status.model} · firmware {status.firmware}</span>{/if}
    {#if status && !status.online}
      <div class="offline" data-testid="offline-banner" role="alert">
        <strong>{camera.name} is offline.</strong>
        <span data-testid="offline-reason">{offlineReason(status.error)}</span>
        {#if status.offlineSince}<span class="meta" data-testid="live-offline-since">Offline since {formatClock(new Date(status.offlineSince).toISOString())} · {timeAgo(status.offlineSince, nowMs)}</span>{/if}
        <button data-testid="retry" disabled={$liveUi.checking} onclick={() => checkLiveStatus(camera.id)}>
          <Icon name="refresh" size={16} /> {$liveUi.checking ? 'Checking…' : 'Retry'}
        </button>
      </div>
    {:else if status?.online}
      <span class="state" data-testid="live-state">
        {paused ? 'Paused while the tab is hidden' : $liveUi.playerState === 'playing' ? 'Live' : $liveUi.playerState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </span>
    {:else}
      <span class="meta">Checking camera…</span>
    {/if}
    {#if streams}<span class="meta" data-testid="live-camera-streams">{streams}</span>{/if}
    {#if proxyInfo}
      <!-- The proxy's state always; its link when it reports one (issue #69). -->
      <!-- One line: "connected" is the link to the proxy's page (Klaus, 2026-09-29). -->
      <span class="meta" data-testid="live-proxy-state">cam-proxy: {#if !proxyInfo.reachable}not available{:else if proxyInfo.webUrl}<a data-testid="live-proxy-link" href={proxyInfo.webUrl} target="_blank" rel="noopener noreferrer"
          onclick={(e) => openProxyClick(e, camera.id, proxyInfo!.webUrl!)}>connected</a>{:else}connected{/if}</span>
    {/if}
  </section>

  {#if status?.online}
    <section class="tile controls" data-testid="live-controls">
      <!-- Icons only, the tooltips explain them (Klaus, 2026-09-29). -->
      <button data-testid="mute-toggle" aria-pressed={!$liveUi.muted} onclick={() => toggleMute()} title={muteTip} aria-label={muteTip}>
        <Icon name={$liveUi.muted ? 'volumeOff' : 'volumeOn'} size={18} />
      </button>
      {#if $liveUi.hevc}
        <button data-testid="quality-toggle" aria-pressed={$liveUi.quality === 'main'} onclick={() => toggleQuality()}
          title={$liveUi.quality === 'main' ? 'Switch to SD' : 'Switch to 4K'}>
          {$liveUi.quality === 'main' ? '4K' : 'SD'}
        </button>
      {/if}
      {#if light !== null}
        <button data-testid="light-toggle" aria-pressed={light} disabled={lightDisabled} onclick={toggleLight} title={lightTip} aria-label={lightTip}>
          <Icon name={light ? 'lightOn' : 'light'} size={18} />
        </button>
      {/if}
      <button data-testid="snapshot" onclick={() => saveSnapshot(camera.id)} disabled={$liveUi.snapshotBusy}
        title={$liveUi.snapshotBusy ? 'Saving…' : 'Save a snapshot'} aria-label={$liveUi.snapshotBusy ? 'Saving…' : 'Save a snapshot'}>
        <Icon name="camera" size={18} />
      </button>
      <button data-testid="fullscreen" onclick={() => liveFullscreen()} title="Fullscreen"><Icon name="expand" size={18} /></button>
      {#if $liveUi.snapshotError}<p class="snapshot-error" data-testid="snapshot-error" role="alert">{$liveUi.snapshotError}</p>{/if}
    </section>
  {/if}

  <!-- Under the controls, with a title (Klaus, 2026-09-28); up to five (2026-09-29). -->
  <section class="tile recent" data-testid="live-recent">
    <h3>Most recent events</h3>
    {#each pendingShown as p (p.start)}
      <div class="latest pending" data-testid="live-latest-pending">
        <span class="dot"></span>
        <span>{orderTriggers(p.kinds).map(label).join(', ')} · recording…</span>
      </div>
    {/each}
    {#each recentShown as e (e.id)}
      {@const kinds = orderTriggers(e.triggers).map((t) => TRIGGER_LABELS[t]).join(', ') || 'Recording'}
      {@const ago = timeAgo(Date.parse(e.start), nowMs)}
      <!-- The row's button fills it; its text lies over it and lets clicks
           through, all but the Vision badges, buttons of their own beside it (issue #113). -->
      <div class="row">
        <button class="open" data-testid="live-latest" title="Play this event" onclick={() => onplay(e)}>
          <img src={thumbUrl(camera.id, e.id)} alt="" loading="lazy" />
          <span class="sr-only">{kinds}, {formatClock(e.start)}, {ago}</span>
        </button>
        <span class="what">
          <strong data-testid="live-latest-kinds" aria-hidden="true">{kinds}</strong>
          {#if badges(e.triggers, e.analysis).length}<span class="badges"><VisionBadges cameraId={camera.id} triggers={e.triggers} analysis={e.analysis} /></span>{/if}
          <span data-testid="live-latest-time" aria-hidden="true">{formatClock(e.start)}</span>
          <span data-testid="live-latest-ago" aria-hidden="true">{ago}</span>
        </span>
      </div>
    {:else}
      {#if !pendingShown.length}<p class="none" data-testid="live-no-events">No events today</p>{/if}
    {/each}
  </section>
</div>

<style>
  .badges { display: flex; gap: 4px; flex-wrap: wrap; }
  .panel { display: flex; flex-direction: column; gap: 12px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; display: flex; flex-direction: column; gap: 6px; }
  h2 { margin: 0; font-size: 17px; }
  .kind { font-size: 13px; }
  .kind small { margin-left: 6px; }
  .meta, .state { font-size: 12px; color: var(--muted); }
  .meta a { color: var(--accent); }
  h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .latest { display: flex; align-items: center; gap: 12px; text-align: left; color: var(--text); font: inherit; padding: 6px; margin: -6px; border: 1px solid transparent; border-radius: 8px; background: none; }
  /* A recent event: the button and its text share one grid cell, the text on
     top. A hover anywhere in the row, badges included, is the row's. */
  .row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); padding: 6px; margin: -6px; border: 1px solid transparent; border-radius: 8px; }
  .row:hover { border-color: var(--accent); }
  .open { grid-area: 1 / 1; display: flex; align-items: center; padding: 0; border: 0; border-radius: 1px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  /* The ring where the row's border is, as when the row was the button. A
     ring's corners are the button's radius plus its offset: 1 + 7 = the row's 8 px. */
  .open:focus-visible { outline-offset: 7px; }
  .open img { width: 96px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: var(--no-thumb-bg); flex: none; }
  .row .what { grid-area: 1 / 1; align-self: center; margin-left: 108px; pointer-events: none; }
  .what { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .what span { color: var(--muted); }
  .pending { cursor: default; }
  .pending .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); animation: pulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .controls { flex-direction: row; flex-wrap: wrap; gap: 8px; }
  .controls button {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 13px; cursor: pointer;
  }
  .controls button:hover { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .controls button[aria-pressed='true'] { border-color: var(--accent); }
  .controls button:disabled { opacity: 0.6; cursor: default; }
  .recent { gap: 10px; }
  .none { margin: 0; font-size: 13px; color: var(--muted); }
  .snapshot-error { margin: 0; width: 100%; font-size: 13px; color: var(--danger); }
  .offline {
    display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px; border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }
  .offline button {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer;
  }
</style>
