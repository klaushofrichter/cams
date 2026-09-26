<script lang="ts">
  import { downloadUrl, formatBytes, formatClock, type EventClip } from '../lib/recordings';

  let { cameraId, events, selectedId }: { cameraId: string; events: EventClip[]; selectedId: string | null } = $props();

  // The selected recording and its neighbours: the cursor decides what's offered.
  const around = $derived.by(() => {
    const i = Math.max(0, events.findIndex((e) => e.id === selectedId));
    return events.slice(Math.max(0, i - 3), i + 4);
  });
</script>

{#if events.length === 0}
  <p class="none">No recordings on this day.</p>
{:else}
  <ul class="rows">
    {#each around as e (e.id)}
      <li class="row" data-testid="download-row" data-clip-id={e.id} aria-current={e.id === selectedId ? 'true' : undefined}>
        <span class="when">{formatClock(e.start)} · {e.durationSec} s</span>
        <a data-testid="download-sub" href={downloadUrl(cameraId, e.id, 'sub')} download>SD <small>{formatBytes(e.sizeSub)}</small></a>
        <a data-testid="download-main" href={downloadUrl(cameraId, e.id, 'main')} download>Full <small>{formatBytes(e.sizeMain)}</small></a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .rows { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); font-size: 13px; }
  .row[aria-current='true'] { border-color: var(--accent); }
  .when { flex: 1; font-family: var(--mono); font-size: 12px; }
  a { padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); text-decoration: none; font-size: 12px; }
  a:hover { border-color: var(--accent); }
  small { color: var(--muted); }
  .none { color: var(--muted); font-size: 14px; }
</style>
