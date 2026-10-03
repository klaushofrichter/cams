<script lang="ts">
  import { localClock as clock } from '../lib/clock';
  // Plan 7: the camera gateway's newest still for Live while its video isn't
  // playing, marked as stills with the still's time and age. One request at a
  // time (a slow link still shows stills), drawn only once loaded; after a
  // failed load it hides and tries again after 5 s; nothing is asked for
  // while `active` is false (Live hidden). `onactive` tells Live whether
  // stills are showing (its header badge).
  let {
    cameraId,
    active = true,
    overlay = false,
    onactive,
  }: { cameraId: string; active?: boolean; overlay?: boolean; onactive?: (on: boolean) => void } = $props();

  let shown = $state<{ url: string; at: number | null } | null>(null);
  let now = $state(Date.now());

  $effect(() => {
    if (!active) return;
    const id = cameraId;
    let loading = false;
    let failedAt = 0;
    let stopped = false;
    let last: string | null = null;
    const show = (next: { url: string; at: number | null } | null) => {
      if (stopped) return;
      const was = shown !== null;
      shown = next;
      if (last) URL.revokeObjectURL(last);
      last = next?.url ?? null;
      if (was !== (next !== null)) onactive?.(next !== null);
    };
    const load = async () => {
      // A local time: reading the `now` state here would make this effect
      // depend on it and re-run every second.
      const t = Date.now();
      now = t;
      if (loading || t - failedAt < 5000) return;
      loading = true;
      try {
        const res = await fetch(`/api/cameras/${encodeURIComponent(id)}/still/latest.jpg?t=${Date.now()}`);
        if (!res.ok) throw new Error(String(res.status));
        const at = Number(res.headers.get('X-Still-Time'));
        const blob = await res.blob();
        show({ url: URL.createObjectURL(blob), at: Number.isFinite(at) && at > 0 ? at : null });
      } catch {
        failedAt = Date.now();
        show(null);
      } finally {
        loading = false;
      }
    };
    void load();
    const t = setInterval(() => void load(), 1000);
    return () => {
      clearInterval(t);
      show(null);
      stopped = true;
    };
  });

  const age = $derived(shown?.at ? Math.max(0, Math.round((now - shown.at) / 1000)) : null);
</script>

{#if shown}
  <figure class="still" class:overlay data-testid="live-still">
    <img src={shown.url} alt="The latest still from the camera gateway" />
    <span class="badge" data-testid="stills-badge" role="status">
      {shown.at ? `STILLS · ${clock(shown.at)} · ${age} s old` : 'STILLS'}
    </span>
    <figcaption>Live video isn't playing: showing stills from the camera gateway, one per second.</figcaption>
  </figure>
{/if}

<style>
  .still { margin: 0; display: grid; gap: 6px; position: relative; }
  .still.overlay { position: absolute; inset: 0; z-index: 2; align-content: center; padding: 8px; background: var(--bg); }
  img { width: 100%; max-height: 70vh; object-fit: contain; background: var(--bg); border-radius: var(--radius); }
  .badge {
    position: absolute; top: 14px; left: 14px; padding: 3px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
    background: var(--warning); color: var(--warning-ink);
  }
  .still:not(.overlay) .badge { top: 8px; left: 8px; }
  figcaption { font-size: 12px; color: var(--muted); }
</style>
