<script lang="ts">
  import { openProxyUi } from '../lib/proxyLink';
  import Icon from './Icon.svelte';
  import { checkLiveStatus, liveFullscreen, liveUi, offlineReason, saveSnapshot, toggleMute, toggleQuality, type StreamInfo } from '../lib/liveUi';
  import { formatClock, thumbUrl, TRIGGER_LABELS, type EventClip } from '../lib/recordings';
  import { timeAgo } from '../lib/clock';
  import type { CameraSummary } from '../lib/stores';
  import type { Pending } from '../lib/eventStream';

  // The Live panel (spec 2026-09-28): the camera, its latest event and the
  // live controls, beside the player column. The stream itself is LiveBox's.
  let { camera, latest, pending, onplay, proxyInfo }: {
    camera: CameraSummary;
    latest: EventClip | null;
    pending: Pending[];
    onplay: (e: EventClip) => void;
    proxyInfo: { reachable: boolean; webUrl: string | null } | null;
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
  const newestPending = $derived(pending.length ? pending.reduce((a, b) => (b.ts > a.ts ? b : a)) : null);
  const label = (kind: string) => TRIGGER_LABELS[kind as keyof typeof TRIGGER_LABELS] ?? kind;
</script>

<div class="panel" data-testid="live-panel">
  <section class="tile">
    <h2 data-testid="live-camera-name">{camera.name}</h2>
    <span class="kind" data-testid="live-camera-kind">{status?.simulator ? 'Simulated camera' : 'Camera'}</span>
    {#if status?.model}<span class="meta" data-testid="live-camera-model">{status.model} · firmware {status.firmware}</span>{/if}
    {#if status && !status.online}
      <div class="offline" data-testid="offline-banner" role="alert">
        <strong>{camera.name} is offline.</strong>
        <span data-testid="offline-reason">{offlineReason(status.error)}</span>
        <button data-testid="retry" disabled={$liveUi.checking} onclick={() => checkLiveStatus(camera.id)}>
          <Icon name="refresh" size={16} /> {$liveUi.checking ? 'Checking…' : 'Retry'}
        </button>
      </div>
    {:else if status?.online}
      <span class="state" data-testid="live-state">
        {$liveUi.playerState === 'playing' ? 'Live' : $liveUi.playerState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </span>
    {:else}
      <span class="meta">Checking camera…</span>
    {/if}
    {#if streams}<span class="meta" data-testid="live-camera-streams">{streams}</span>{/if}
    {#if proxyInfo?.webUrl}
      <a class="meta" data-testid="live-proxy-link" href={proxyInfo.webUrl} target="_blank" rel="noopener noreferrer"
        onclick={(e) => { e.preventDefault(); void openProxyUi(camera.id, proxyInfo!.webUrl!); }}>cam-proxy {proxyInfo.reachable ? '' : '(down)'}</a>
    {/if}
  </section>

  {#if status?.online}
    <section class="tile controls" data-testid="live-controls">
      <button data-testid="mute-toggle" aria-pressed={!$liveUi.muted} onclick={() => toggleMute()} title={$liveUi.muted ? 'Unmute' : 'Mute'}>
        <Icon name={$liveUi.muted ? 'volumeOff' : 'volumeOn'} size={18} /><span>{$liveUi.muted ? 'Muted' : 'Sound'}</span>
      </button>
      {#if $liveUi.hevc}
        <button data-testid="quality-toggle" aria-pressed={$liveUi.quality === 'main'} onclick={() => toggleQuality()} title="Switch stream quality">
          {$liveUi.quality === 'main' ? 'HD' : 'SD'}
        </button>
      {/if}
      <button data-testid="snapshot" onclick={() => saveSnapshot(camera.id)} disabled={$liveUi.snapshotBusy} title="Save a snapshot">
        <Icon name="camera" size={18} /><span>{$liveUi.snapshotBusy ? 'Saving…' : 'Snapshot'}</span>
      </button>
      <button data-testid="fullscreen" onclick={() => liveFullscreen()} title="Fullscreen"><Icon name="expand" size={18} /></button>
      {#if $liveUi.snapshotError}<p class="snapshot-error" data-testid="snapshot-error" role="alert">{$liveUi.snapshotError}</p>{/if}
    </section>
  {/if}

  {#if newestPending || latest}
  <!-- Under the controls, with a title (Klaus, 2026-09-28). -->
  <section class="tile recent" data-testid="live-recent">
    <h3>Most recent event</h3>
    {#if newestPending}
      <div class="latest pending" data-testid="live-latest-pending">
        <span class="dot"></span>
        <span>{label(newestPending.kind)} · recording…</span>
      </div>
    {:else if latest}
      <button class="latest" data-testid="live-latest" title="Play this event" onclick={() => onplay(latest)}>
        <img src={thumbUrl(camera.id, latest.id)} alt="" loading="lazy" />
        <span class="what">
          <strong>{latest.triggers.map((t) => TRIGGER_LABELS[t]).join(', ') || 'Recording'}</strong>
          <span>{formatClock(latest.start)}</span>
          <span data-testid="live-latest-ago">{timeAgo(Date.parse(latest.start), nowMs)}</span>
        </span>
      </button>
    {/if}
  </section>
  {/if}
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: 12px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; display: flex; flex-direction: column; gap: 6px; }
  h2 { margin: 0; font-size: 17px; }
  .kind { font-size: 13px; }
  .meta, .state { font-size: 12px; color: var(--muted); }
  a.meta { color: var(--accent); }
  h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .latest { display: flex; align-items: center; gap: 12px; text-align: left; color: var(--text); font: inherit; padding: 6px; margin: -6px; border: 1px solid transparent; border-radius: 8px; background: none; cursor: pointer; }
  button.latest:hover { border-color: var(--accent); }
  .latest img { width: 96px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: var(--no-thumb-bg); flex: none; }
  .what { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
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
