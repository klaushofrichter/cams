<script lang="ts">
  import { openProxyClick } from '../lib/proxyLink';
  import { cameras } from '../lib/stores';
  import { putJson } from '../lib/settings';
  import { getJson } from '../lib/api';
  import Icon from './Icon.svelte';

  // The "use cam-proxy" switch for one camera, for all users (Klaus,
  // 2026-09-27). Nothing is shown for a camera without a cam-proxy. The
  // camera list is updated on success, so Live, Recordings and Timeline follow.
  let { cameraId }: { cameraId: string } = $props();

  const camera = $derived($cameras.find((c) => c.id === cameraId));
  let saving = $state(false);
  // The proxy's own web page, while it answers (Klaus, 2026-09-28).
  let info = $state<{ reachable: boolean; webUrl: string | null } | null>(null);
  const configured = $derived(!!camera?.proxyConfigured); // a plain value: camera-list reloads don't refetch
  $effect(() => {
    const id = cameraId;
    info = null;
    if (!configured) return;
    let stale = false;
    getJson<{ reachable: boolean; webUrl: string | null }>(`/api/cameras/${encodeURIComponent(id)}/proxy/info`)
      .then((r) => { if (!stale) info = r; })
      .catch(() => { if (!stale) info = { reachable: false, webUrl: null }; });
    return () => (stale = true);
  });
  let error = $state('');

  // Another camera picked on Settings: its own state, no leftover error.
  $effect(() => {
    void cameraId;
    error = '';
  });

  async function toggle(e: Event) {
    const box = e.currentTarget as HTMLInputElement;
    const enabled = box.checked;
    const id = cameraId; // the camera switched, even if the picker moves on
    saving = true;
    error = '';
    try {
      const res = await putJson<{ enabled?: boolean }>(`/api/cameras/${encodeURIComponent(id)}/proxy`, { enabled });
      if (res.status !== 200 || res.body.enabled !== enabled) throw new Error(String(res.status));
      cameras.update((list) => list.map((c) => (c.id === id ? { ...c, proxy: enabled } : c)));
    } catch {
      if (id !== cameraId) return; // the box now shows another camera
      box.checked = !enabled;
      error = 'Could not change the setting. Try again.';
    } finally {
      saving = false;
    }
  }
</script>

{#if camera?.proxyConfigured}
  <label class="row">
    <input type="checkbox" data-testid="proxy-toggle" checked={!!camera.proxy} disabled={saving} onchange={toggle} />
    Use cam-proxy
  </label>
  <p class="muted" data-testid="proxy-note">
    {#if camera.proxy}
      Clips, event thumbnails, stills and events come from the camera's cam-proxy first, and from the camera when the proxy can't help.
    {:else}
      Off: clips, event thumbnails and events come only from the camera. Live shows no stills while the video is down.
    {/if}
    Applies to everyone.
  </p>
  {#if info?.webUrl}
    <p class="link">
      <a data-testid="proxy-web-link" href={info.webUrl} target="_blank" rel="noopener noreferrer"
        onclick={(e) => openProxyClick(e, cameraId, info!.webUrl!)}>Open this camera's cam-proxy <Icon name="external" size={14} /></a>
    </p>
  {:else if info && !info.reachable}
    <p class="muted" data-testid="proxy-unreachable">The cam-proxy isn't answering right now.</p>
  {/if}
  {#if error}<p class="err" role="alert" data-testid="proxy-error">{error}</p>{/if}
{/if}

<style>
  .row { display: flex; align-items: center; gap: 8px; }
  .muted { margin: 0; color: var(--muted); font-size: 13px; }
  .err { margin: 0; color: var(--danger); font-size: 13px; }
  .link { margin: 0; font-size: 13px; }
  .link a { display: inline-flex; align-items: center; gap: 4px; }
</style>
