<script lang="ts">
  import { badges, type CardAnalysis } from '../lib/vision';

  // Vision's word on a card: History's list and Live's recent events.
  let { triggers, analysis }: { triggers: readonly string[]; analysis?: CardAnalysis } = $props();
  const list = $derived(badges(triggers, analysis));
</script>

{#each list as b (b.kind + b.category)}<span class="vision {b.kind}" title={b.title} data-testid="vision-badge" data-kind={b.kind}>{b.text}</span>{/each}

<style>
  .vision { font-size: 10px; padding: 0 7px; border-radius: 999px; border: 1px solid #a855f7; color: #a855f7; white-space: nowrap; line-height: 1.6; }
  .vision.not-confirmed, .vision.extra { border-style: dashed; border-color: var(--muted); color: var(--muted); }
</style>
