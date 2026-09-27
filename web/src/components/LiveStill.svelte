<script lang="ts">
  // Plan 7: the camera gateway's newest still for Live while its video isn't
  // playing. Each still loads off-screen first: a new one is asked for only
  // once the last is done (a slow link shows stills, never a blank box), and
  // only a loaded still is drawn. After a failed load (no recent still, the
  // gateway down) it hides and tries again after 5 s. Nothing is asked for
  // while `active` is false (Live hidden).
  let { cameraId, active = true, overlay = false }: { cameraId: string; active?: boolean; overlay?: boolean } = $props();

  let shown = $state<string | null>(null);
  $effect(() => {
    if (!active) return;
    const id = cameraId;
    let loading = false;
    let failedAt = 0;
    let stopped = false;
    const next = () => {
      if (loading || Date.now() - failedAt < 5000) return;
      loading = true;
      const url = `/api/cameras/${encodeURIComponent(id)}/still/latest.jpg?t=${Date.now()}`;
      const img = new Image();
      img.onload = () => {
        loading = false;
        if (!stopped) shown = url;
      };
      img.onerror = () => {
        loading = false;
        failedAt = Date.now();
        if (!stopped) shown = null;
      };
      img.src = url;
    };
    next();
    const t = setInterval(next, 1000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  });
</script>

{#if shown}
  <figure class="still" class:overlay data-testid="live-still">
    <img src={shown} alt="The latest still from the camera gateway" />
    <figcaption>Live video isn't playing: stills from the camera gateway.</figcaption>
  </figure>
{/if}

<style>
  .still { margin: 0; display: grid; gap: 6px; }
  .still.overlay { position: absolute; inset: 0; z-index: 2; align-content: center; padding: 8px; background: var(--bg); }
  img { width: 100%; max-height: 70vh; object-fit: contain; background: var(--bg); border-radius: var(--radius); }
  figcaption { font-size: 12px; color: var(--muted); }
</style>
