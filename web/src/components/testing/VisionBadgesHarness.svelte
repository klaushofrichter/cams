<script lang="ts">
  import VisionBadges from '../VisionBadges.svelte';
  import type { CardAnalysis } from '../../lib/vision';

  // The badges beside a card button, as History and Live show them (issue
  // #113): a badge click must open the dialog and never reach the card.
  let { cameraId, triggers, analysis, oncard }: { cameraId: string; triggers: string[]; analysis?: CardAnalysis; oncard: () => void } = $props();
</script>

<div><button data-testid="card" onclick={oncard} onkeydown={oncard}>card</button><span><VisionBadges {cameraId} {triggers} {analysis} /></span></div>
