<script lang="ts">
  import { localClock } from '../lib/clock';
  import { eventPlace, findings, type DayCheck } from '../lib/stillChecks';

  // The day's still checks on the Timeline (cams #179): time, what Vision
  // found, the event it sits in. A row opens its second.
  let { checks, current, onopen }: { checks: DayCheck[]; current: number | null; onopen: (ts: number) => void } = $props();
</script>

<section class="checks" aria-label="Still checks of the day" data-testid="checks-list">
  {#if checks.length}
    <ul>
      {#each checks as c (c.id ?? c.stillTs)}
        <li>
          <button class:sel={current === c.stillTs} aria-current={current === c.stillTs ? 'true' : undefined} onclick={() => onopen(c.stillTs)} data-testid="checks-row" data-ts={c.stillTs}>
            <span class="time mono">{localClock(c.stillTs)}</span>
            <span class="found" class:none={!c.summary.length}>{findings(c.summary)}</span>
            <span class="where muted">{eventPlace(c.events)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted">No checks on this day. Open a second and press “✧ Check with Vision”.</p>
  {/if}
</section>

<style>
  .checks { padding: 8px 10px; border-radius: var(--radius); border: 1px dashed var(--vision-mark); background: var(--surface); font-size: 13px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; }
  button { width: 100%; display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: baseline; padding: 6px 8px; border: 0; border-left: 3px solid transparent; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  button:hover { background: color-mix(in srgb, var(--vision-mark) 10%, transparent); }
  button:focus-visible { outline: 2px solid var(--vision-mark); outline-offset: -2px; }
  button.sel { border-left-color: var(--vision-mark); background: color-mix(in srgb, var(--vision-mark) 16%, transparent); }
  .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .found { color: var(--vision-mark); font-weight: 600; overflow-wrap: anywhere; }
  .found.none { color: var(--muted); font-weight: 400; }
  .muted { color: var(--muted); margin: 0; }
  @media (max-width: 600px) {
    button { grid-template-columns: auto 1fr; min-height: 44px; }
    .where { grid-column: 2; }
  }
</style>
