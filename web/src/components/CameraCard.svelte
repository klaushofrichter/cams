<script lang="ts">
  import Icon from './Icon.svelte';
  import { openProxyClick } from '../lib/proxyLink';
  import { showsAdminControls } from '../lib/session';
  import { cameraById, me } from '../lib/stores';
  import { checkLiveStatus, liveUi, offlineReason } from '../lib/liveUi';
  import { formatClock } from '../lib/recordings';
  import { timeAgo } from '../lib/clock';

  // The Video page's camera card (spec 2026-10-04): the camera's name, linked
  // to its own web page, a small "Proxy" link when it has a cam-proxy, and a
  // status dot. The name is the camera store's (#169), so a rename made
  // anywhere shows at once. Model and firmware are on Settings.
  let { cameraId, proxyInfo }: {
    cameraId: string;
    proxyInfo: { reachable: boolean; webUrl: string | null } | null; // null: no cam-proxy
  } = $props();

  const camera = $derived($cameraById(cameraId) ?? null);
  const name = $derived(camera?.name ?? cameraId);
  // Another camera's status (a switch in flight) counts as not known yet.
  const status = $derived($liveUi.status?.id === cameraId ? $liveUi.status : null);
  const dot = $derived(!status || ($liveUi.checking && !status.online) ? 'checking' : status.online ? 'online' : 'offline');
  const stateText = $derived(dot === 'online' ? 'Online' : dot === 'offline' ? 'Offline' : 'Checking…');
  const proxyTip = $derived(!proxyInfo ? '' : !proxyInfo.reachable ? "cam-proxy isn't reachable right now" : proxyInfo.webUrl ? "Opens the camera's cam-proxy" : 'cam-proxy is connected; it has no web page');

  // "Offline since 12:03 · 5 minutes ago", kept current.
  let nowMs = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (nowMs = Date.now()), 30_000);
    return () => clearInterval(id);
  });
</script>

<section class="tile" data-testid="camera-card">
  <div class="head">
    <span class="dot" data-testid="camera-status" data-state={dot} role="img" title={stateText} aria-label={stateText}></span>
    {#if camera?.webUiUrl}
      <a class="name" data-testid="camera-card-name" href={camera.webUiUrl} target="_blank" rel="noopener noreferrer"
        title="Opens the camera's own web page. Works on the home network only.">{name}</a>
    {:else}
      <!-- A camera without a web page (a simulated one) says why on hover. -->
      <span class="name" data-testid="camera-card-name" title={camera?.webUiNote ?? undefined}>{name}</span>
    {/if}
    {#if status?.simulator}
      <span class="sim" data-testid="camera-card-sim" title={`Simulated camera: ${status.simulator}`}>Simulated</span>
    {/if}
    {#if proxyInfo}
      {#if proxyInfo.reachable && proxyInfo.webUrl}
        <a class="proxy" data-testid="camera-card-proxy" href={proxyInfo.webUrl} target="_blank" rel="noopener noreferrer" title={proxyTip}
          onclick={(e) => (showsAdminControls($me) ? openProxyClick(e, cameraId, proxyInfo!.webUrl!) : undefined)}>Proxy <Icon name="external" size={12} /></a>
      {:else}
        <span class="proxy off" data-testid="camera-card-proxy" data-reachable={proxyInfo.reachable} title={proxyTip}>Proxy</span>
      {/if}
    {/if}
  </div>
  {#if status && !status.online}
    <div class="offline" data-testid="offline-banner" role="alert">
      <strong>{name} is offline.</strong>
      <span data-testid="offline-reason">{offlineReason(status.error)}</span>
      {#if status.offlineSince}<span class="meta" data-testid="live-offline-since">Offline since {formatClock(new Date(status.offlineSince).toISOString())} · {timeAgo(status.offlineSince, nowMs)}</span>{/if}
      <button data-testid="retry" disabled={$liveUi.checking} onclick={() => checkLiveStatus(cameraId)}>
        <Icon name="refresh" size={16} /> {$liveUi.checking ? 'Checking…' : 'Retry'}
      </button>
    </div>
  {/if}
</section>

<style>
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  .head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name { font-size: 17px; font-weight: 700; color: var(--text); text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a.name:hover { color: var(--accent); text-decoration: underline; }
  .sim { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 999px; color: var(--muted); border: 1px solid var(--border); cursor: help; }
  .proxy { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--accent); text-decoration: none; }
  .proxy:hover { text-decoration: underline; }
  .proxy.off { color: var(--muted); cursor: help; }
  .proxy.off:hover { text-decoration: none; }
  .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
  .dot[data-state='online'] { background: var(--ok); }
  .dot[data-state='offline'] { background: var(--danger); }
  .dot[data-state='checking'] { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .meta { font-size: 12px; color: var(--muted); }
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
