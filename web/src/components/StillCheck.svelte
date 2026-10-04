<script lang="ts">
  import { checkButton, CheckError, confirmsLine, findings, requestCheck, reusedLine, usageLine, type CheckResult, type DayCheck, type UsageState } from '../lib/stillChecks';

  // "✧ Check with Vision" under the Timeline's large still (cams #179, spec
  // 2026-10-04-still-checks-ui-design): the button with its state and the
  // budget, a spinner while Vision looks, then the result's words (the boxes
  // are on the still itself) or why it failed.
  let {
    base,
    ts,
    gap,
    check,
    analysed,
    usage,
    onresult,
    ondone,
  }: {
    base: string;
    ts: number;
    gap: boolean;
    check: DayCheck | null;
    analysed: boolean;
    usage: UsageState;
    onresult: (r: CheckResult) => void;
    ondone: () => void;
  } = $props();

  // Per second: a request still running or an answer for another second
  // doesn't show on this one.
  let running = $state<number | null>(null);
  let failure = $state<{ ts: number; text: string } | null>(null);
  let answer = $state<{ ts: number; reused: boolean; source?: string } | null>(null);

  const btn = $derived(checkButton({ ts, gap, checked: check !== null, analysed, running: running === ts, usage }));
  const error = $derived(failure?.ts === ts ? failure.text : '');
  const reused = $derived(answer?.ts === ts ? reusedLine(answer) : '');
  const confirms = $derived(check ? confirmsLine(check.events) : '');
  const usageText = $derived(usageLine(usage));

  async function run() {
    const at = ts;
    running = at;
    failure = null;
    try {
      const r = await requestCheck(base, at);
      answer = { ts: at, reused: r.reused, source: r.source };
      onresult(r);
    } catch (err) {
      failure = { ts: at, text: err instanceof CheckError ? err.text : 'The check failed.' };
    } finally {
      if (running === at) running = null;
      ondone();
    }
  }
</script>

<div class="check" data-testid="still-check">
  <div class="row">
    <button class="go" data-testid="still-check-button" disabled={btn.disabled} title={btn.reason ?? (check ? 'Checked by hand: the result is shown' : 'Send this still to Google Vision')}
      aria-busy={running === ts} onclick={() => void run()}>
      {#if running === ts}<span class="spinner" aria-hidden="true" data-testid="still-check-spinner"></span>{/if}{btn.label}
    </button>
    {#if usageText}<span class="muted" data-testid="still-check-usage">{usageText}</span>{/if}
  </div>
  {#if btn.reason && running !== ts}<p class="muted" data-testid="still-check-reason">{btn.reason}</p>{/if}
  {#if error}<p class="error" role="alert" data-testid="still-check-error">{error}</p>{/if}
  {#if check}
    <p data-testid="still-check-result">
      <span class="vision">✧ Vision: {findings(check.summary)}</span>{#if confirms}<span data-testid="still-check-confirms"> · {confirms}</span>{/if}{#if reused}<span class="muted" data-testid="still-check-reused"> · {reused}</span>{/if}
    </p>
  {/if}
</div>

<style>
  .check { display: grid; gap: 4px; font-size: 13px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  p { margin: 0; }
  .muted { color: var(--muted); }
  .error { color: var(--danger); }
  .vision { color: var(--vision-mark); font-weight: 600; }
  .go { display: inline-flex; align-items: center; gap: 6px; font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--vision-mark); border-radius: 8px; padding: 4px 10px; min-height: 36px; cursor: pointer; }
  .go:disabled { opacity: 0.6; cursor: default; border-color: var(--border); }
  .spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--vision-mark); animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
  @media (max-width: 600px) { .go { min-height: 44px; } }
</style>
