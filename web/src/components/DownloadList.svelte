<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { COLLAPSE_OVER, downloadUrl, formatBytes, formatClock, groupByHour, type EventClip } from '../lib/recordings';

  let { cameraId, events, date, selectedId }: { cameraId: string; events: EventClip[]; date: string; selectedId: string | null } = $props();

  const groups = $derived(groupByHour(events, date));

  // Open/closed state per `date|hour`, kept once decided so a refresh never
  // reopens or re-collapses a group the viewer has already seen.
  let groupOpen: Record<string, boolean> = $state({});
  const keyOf = (hour: number) => `${date}|${hour}`;

  let listEl: HTMLElement | undefined = $state();
  let prevSelected: string | null = null;

  $effect(() => {
    const gs = groups;
    const id = selectedId;
    const changed = id !== prevSelected;
    prevSelected = id;
    const updates: Record<string, boolean> = {};
    untrack(() => {
      for (const g of gs) {
        const key = keyOf(g.hour);
        if (!(key in groupOpen)) {
          updates[key] = g.events.length <= COLLAPSE_OVER || g.events.some((e) => e.id === id);
        }
      }
      // The selection moved into a collapsed group (this list has no click
      // selection of its own, so any change comes from outside it): open it.
      if (changed && id) {
        const g = gs.find((g) => g.events.some((e) => e.id === id));
        if (g) {
          const key = keyOf(g.hour);
          const willBeOpen = key in updates ? updates[key] : groupOpen[key];
          if (willBeOpen === false) updates[key] = true;
        }
      }
    });
    if (Object.keys(updates).length) groupOpen = { ...groupOpen, ...updates };

    if (changed && id) {
      const target = id;
      void tick().then(() => {
        listEl?.querySelector<HTMLElement>(`[data-testid="download-row"][data-clip-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    }
  });

  function toggle(hour: number) {
    const key = keyOf(hour);
    groupOpen = { ...groupOpen, [key]: !groupOpen[key] };
  }
</script>

{#if events.length === 0}
  <p class="none">No recordings on this day.</p>
{:else}
  <div class="groups" bind:this={listEl}>
    {#each groups as g (g.hour)}
      {@const open = groupOpen[keyOf(g.hour)] ?? true}
      <section class="group" data-testid="hour-group" data-hour={g.hour}>
        <button class="group-head" data-testid="hour-toggle" aria-expanded={open} onclick={() => toggle(g.hour)}>
          <span class="label">{g.label}</span>
          <span class="count" data-testid="hour-count">{g.events.length} {g.events.length === 1 ? 'event' : 'events'}</span>
        </button>
        {#if open}
          <ul class="rows">
            {#each g.events as e (e.id)}
              <li class="row" data-testid="download-row" data-clip-id={e.id} aria-current={e.id === selectedId ? 'true' : undefined}>
                <span class="when">{formatClock(e.start)} · {e.durationSec} s</span>
                <a data-testid="download-sub" href={downloadUrl(cameraId, e.id, 'sub')} download>SD <small>{formatBytes(e.sizeSub)}</small></a>
                <a data-testid="download-main" href={downloadUrl(cameraId, e.id, 'main')} download>Full <small>{formatBytes(e.sizeMain)}</small></a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  .groups { display: flex; flex-direction: column; gap: 10px; }
  .group-head {
    position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface);
    color: var(--text); font-size: 12px; cursor: pointer;
  }
  .group-head .label { font-weight: 600; }
  .group-head .count { color: var(--muted); }
  .rows { list-style: none; padding: 0; margin: 6px 0 0; display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); font-size: 13px; }
  .row[aria-current='true'] { border-color: var(--accent); }
  .when { flex: 1; font-family: var(--mono); font-size: 12px; }
  a { padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); text-decoration: none; font-size: 12px; }
  a:hover { border-color: var(--accent); }
  small { color: var(--muted); }
  .none { color: var(--muted); font-size: 14px; }
</style>
