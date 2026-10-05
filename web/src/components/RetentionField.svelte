<script lang="ts">
  import { DEFAULT_RETENTION_DAYS, RETENTION_MAX_DAYS } from '../lib/archive';

  // How long the Archive keeps a clip (contract §1): whole days 1 to 36500,
  // or forever (null). The field keeps its number while Forever is on.
  let { days = $bindable(DEFAULT_RETENTION_DAYS), testid = 'retention' }: { days?: number | null; testid?: string } = $props();
  let typed = $state<number | string>(days ?? DEFAULT_RETENTION_DAYS);
  let forever = $state(days === null);
  $effect(() => {
    const n = Number(typed);
    days = forever ? null : typed === '' || !Number.isFinite(n) ? NaN : n;
  });
</script>

<div class="retention" data-testid={testid}>
  <label class="days">Keep for
    <input type="number" data-testid={`${testid}-days`} min="1" max={RETENTION_MAX_DAYS} step="1" disabled={forever} bind:value={typed} aria-label="Days to keep" />
    days</label>
  <label class="row"><input type="checkbox" data-testid={`${testid}-forever`} bind:checked={forever} /> Forever</label>
</div>

<style>
  .retention { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 13px; }
  .days { display: flex; align-items: center; gap: 6px; }
  .days input { width: 90px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  .days input:disabled { opacity: 0.45; }
  .row { display: flex; align-items: center; gap: 6px; }
</style>
