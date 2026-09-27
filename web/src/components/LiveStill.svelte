<script lang="ts">
  // Plan 7: the camera gateway's newest still, reloaded every second, for
  // Live while its video isn't playing. After a failed load (no recent
  // still, gateway down) it hides and tries again after a few seconds.
  let { cameraId }: { cameraId: string } = $props();

  let tick = $state(Date.now());
  let failedAt = $state<number | null>(null);
  $effect(() => {
    const t = setInterval(() => {
      tick = Date.now();
      if (failedAt !== null && tick - failedAt >= 5000) failedAt = null;
    }, 1000);
    return () => clearInterval(t);
  });
  const src = $derived(`/api/cameras/${encodeURIComponent(cameraId)}/still/latest.jpg?t=${tick}`);
</script>

{#if failedAt === null}
  <figure class="still" data-testid="live-still">
    <img {src} alt="The latest still from the camera gateway" onerror={() => (failedAt = Date.now())} />
    <figcaption>Live video isn't playing: stills from the camera gateway, updated every second.</figcaption>
  </figure>
{/if}

<style>
  .still { margin: 0; display: grid; gap: 6px; }
  img { width: 100%; max-height: 70vh; object-fit: contain; background: var(--bg); border-radius: var(--radius); }
  figcaption { font-size: 12px; color: var(--muted); }
</style>
