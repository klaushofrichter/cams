<script lang="ts">
  import VisionBadges from '../VisionBadges.svelte';
  import type { CardAnalysis } from '../../lib/vision';

  // The badges inside a card button, as History and Live show them: a badge
  // click must open the dialog and never reach the card.
  let { cameraId, triggers, analysis, oncard }: { cameraId: string; triggers: string[]; analysis?: CardAnalysis; oncard: () => void } = $props();
</script>

<button data-testid="card" onclick={oncard} onkeydown={oncard}><VisionBadges {cameraId} {triggers} {analysis} /></button>
