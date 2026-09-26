<script lang="ts">
  import { formatNow, now } from '../lib/clock';
</script>

<time class="clock" data-testid="top-clock" datetime={$now.toISOString()} aria-label="Current time">{formatNow($now)}</time>

<style>
  .clock { font-family: var(--mono); font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
