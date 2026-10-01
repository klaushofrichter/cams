<script lang="ts">
  import VisionDialog from './VisionDialog.svelte';
  import { badges, type CardAnalysis, type Category } from '../lib/vision';

  // Vision's word on a card: History's list and Live's recent events. Colour by
  // confidence; a badge opens the analysed still with its boxes (Klaus,
  // 2026-09-30). The card is a <button>, so a badge is a span with the button
  // role, and its click or key never reaches the card.
  let { cameraId, triggers, analysis }: { cameraId: string; triggers: readonly string[]; analysis?: CardAnalysis } = $props();
  const list = $derived(badges(triggers, analysis));

  let shown = $state<Category | null>(null);
  let opener: HTMLElement | null = null;

  function show(e: Event, k: Category) {
    e.preventDefault();
    e.stopPropagation();
    opener = e.currentTarget as HTMLElement;
    shown = k;
  }
  function onkey(e: KeyboardEvent, k: Category) {
    if (e.key === 'Enter' || e.key === ' ') show(e, k);
  }
  // Focus back to the badge first, so the dialog's removal doesn't drop it.
  function close() {
    opener?.focus();
    shown = null;
  }
</script>

{#each list as b (b.kind + b.category)}<span class="vision {b.kind}" role="button" tabindex="0" title={b.title} data-testid="vision-badge" data-kind={b.kind} data-level={b.level} onclick={(e) => show(e, b.category)} onkeydown={(e) => onkey(e, b.category)}>{b.text}</span>{/each}
{#if shown && analysis}<VisionDialog {cameraId} {analysis} category={shown} onclose={close} />{/if}

<style>
  .vision { font-size: 10px; padding: 0 7px; border-radius: 999px; border: 1px solid var(--vision-mid); color: var(--vision-mid); white-space: nowrap; line-height: 1.6; cursor: pointer; }
  .vision[data-level='high'] { border-color: var(--vision-high); color: var(--vision-high); }
  .vision[data-level='low'] { border-color: var(--vision-low); color: var(--vision-low); }
  /* Extra: Vision's own finding, not the camera's label -- dashed. */
  .vision.extra { border-style: dashed; }
  .vision.not-confirmed { border-style: dashed; border-color: var(--muted); color: var(--muted); }
  .vision:hover { background: var(--surface-2); }
</style>
