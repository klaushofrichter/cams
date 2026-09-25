<script lang="ts">
  import { navigate, route, type Panel } from '../lib/router';
  const TABS: { id: Panel; label: string }[] = [
    { id: 'history', label: 'History' },
    { id: 'events', label: 'Events' },
    { id: 'downloads', label: 'Downloads' },
  ];
</script>

<section class="page">
  <h1 data-testid="page-title">Recordings</h1>
  <div class="tabs" role="tablist">
    {#each TABS as tab (tab.id)}
      <button
        role="tab"
        data-testid={`panel-tab-${tab.id}`}
        aria-selected={$route.panel === tab.id}
        class:on={$route.panel === tab.id}
        onclick={() => navigate(`/app/recordings?panel=${tab.id}`)}>{tab.label}</button>
    {/each}
  </div>
  <div class="placeholder">The recordings workspace arrives in a later release.</div>
</section>

<style>
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; }
  .tabs button { padding: 6px 14px; border-radius: 9px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .tabs button.on { background: var(--surface-2); color: var(--text); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
</style>
