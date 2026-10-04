<script lang="ts">
  import { ALL_KINDS, isAllKinds, toggleFilter, TRIGGER_LABELS, type Filter } from '../lib/recordings';

  // The event-type chips, History's list and the Live panel's recent events
  // alike (Klaus, 2026-10-03). Several kinds at once; All is every kind
  // (2026-09-28). The selection is the eventFilter preference (eventFilter.ts).
  let { filter, onfilter }: { filter: Filter; onfilter: (f: Filter) => void } = $props();
</script>

<div class="filters" data-testid="event-filter" role="group" aria-label="Filter events">
  <button data-testid="filter-all" aria-pressed={isAllKinds(filter)} onclick={() => onfilter(toggleFilter(filter, 'all'))}>All</button>
  {#each ALL_KINDS as f (f)}
    <button data-testid={`filter-${f}`} aria-pressed={!isAllKinds(filter) && filter.includes(f)} onclick={() => onfilter(toggleFilter(filter, f))}>{TRIGGER_LABELS[f]}</button>
  {/each}
</div>

<style>
  .filters { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
  .filters button { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .filters button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); border-color: var(--accent); }
</style>
