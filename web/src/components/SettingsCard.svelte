<script lang="ts">
  import type { Snippet } from 'svelte';
  let { id, title, description = '', children, footer }: { id: string; title: string; description?: string; children: Snippet; footer?: Snippet } = $props();
</script>

<section class="card" data-testid={`settings-card-${id}`} aria-labelledby={`card-${id}-title`}>
  <header>
    <h2 id={`card-${id}-title`}>{title}</h2>
    {#if description}<p>{description}</p>{/if}
  </header>
  <div class="body">{@render children()}</div>
  {#if footer}<footer>{@render footer()}</footer>{/if}
</section>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
  header h2 { margin: 0; font-size: 16px; }
  header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .body { display: grid; gap: 12px; }
  footer { display: flex; align-items: center; gap: 12px; justify-content: flex-end; border-top: 1px solid var(--border); padding-top: 12px; }
</style>
