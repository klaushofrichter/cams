<script lang="ts">
  import VisionDialog from './VisionDialog.svelte';
  import { badges, type CardAnalysis, type Category } from '../lib/vision';

  // Vision's word on a card: History's list and Live's recent events. Colour by
  // confidence; a badge opens the analysed still with its boxes (Klaus,
  // 2026-09-30). Each badge is a native button beside the card's button, not
  // in it (issue #113): Enter and Space are the browser's, and Space clicks
  // on keyup, so the dialog's focus (✕) never sees that keyup.
  // `wrap`: in a span of their own, and no span when there are none (Live's rows).
  let { cameraId, triggers, analysis, wrap = false }: { cameraId: string; triggers: readonly string[]; analysis?: CardAnalysis; wrap?: boolean } = $props();
  const list = $derived(badges(triggers, analysis));

  let shown = $state<Category | null>(null);
  let opener: HTMLElement | null = null;

  function show(e: MouseEvent, k: Category) {
    opener = e.currentTarget as HTMLElement;
    shown = k;
  }
  // A live update that drops the analysis or the opened badge closes the
  // dialog, so it can't come back by itself when the badge does.
  $effect(() => {
    if (shown && !list.some((b) => b.category === shown)) shown = null;
  });
  // Focus back to the badge first, so the dialog's removal doesn't drop it.
  function close() {
    opener?.focus();
    shown = null;
  }
</script>

{#snippet buttons()}{#each list as b (b.kind + b.category)}<button type="button" class="vision {b.kind}" title={b.title} aria-label={b.label} data-testid="vision-badge" data-kind={b.kind} data-level={b.level} onclick={(e) => show(e, b.category)}>{b.text}</button>{/each}{/snippet}
{#if !wrap}{@render buttons()}{:else if list.length}<span class="badges">{@render buttons()}</span>{/if}
{#if shown && analysis}<VisionDialog {cameraId} {analysis} category={shown} onclose={close} />{/if}

<style>
  .badges { display: flex; gap: 4px; flex-wrap: wrap; }
  /* A button that looks like the card's tags. pointer-events: the card's text
     around it lets clicks through to the card's button underneath. */
  .vision {
    margin: 0; font: inherit; font-size: 10px; padding: 0 7px; border-radius: 999px; border: 1px solid var(--vision-mid); background: transparent;
    color: var(--vision-mid); white-space: nowrap; line-height: 1.6; cursor: pointer; pointer-events: auto;
  }
  .vision[data-level='high'] { border-color: var(--vision-high); color: var(--vision-high); }
  .vision[data-level='low'] { border-color: var(--vision-low); color: var(--vision-low); }
  /* Extra: Vision's own finding, not the camera's label -- dashed. */
  .vision.extra { border-style: dashed; }
  .vision.not-confirmed { border-style: dashed; border-color: var(--muted); color: var(--muted); }
  /* A tint of the badge's own colour: visible on a hovered card too. */
  .vision:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
  .vision:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
</style>
