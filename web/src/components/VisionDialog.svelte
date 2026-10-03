<script lang="ts">
  import { onMount, tick } from 'svelte';
  import TimelineStill from './TimelineStill.svelte';
  import { getJson } from '../lib/api';
  import { portal } from '../lib/portal';
  import { formatClock as clock, localDate } from '../lib/recordings';
  import { navigate } from '../lib/router';
  import { historyHref, openHistory } from '../lib/timeline';
  import { findingLine, LABEL, type CardAnalysis, type Category, type StillObject } from '../lib/vision';

  // A Vision badge's dialog (Klaus, 2026-09-30): the card's analysed still with
  // Vision's boxes, the best one for the clicked category first; ◀ ▶ step
  // through the card's other analysed stills.
  let { cameraId, analysis, category, onclose }: { cameraId: string; analysis: CardAnalysis; category: Category; onclose: () => void } = $props();

  const stills = $derived(analysis.stills);
  // The still where Vision saw the category best; for "not confirmed", the
  // still of an analysis of that kind (issue #113), else (an older server
  // without `kind`) one where it saw none, else the first.
  function startIndex(): number {
    let best = -1;
    let score = -1;
    analysis.stills.forEach((s, i) => {
      for (const e of s.summary) if (e.category === category && e.score > score) [best, score] = [i, e.score];
    });
    if (best >= 0) return best;
    const own = analysis.stills.findIndex((s) => s.kind === category);
    if (own >= 0) return own;
    const none = analysis.stills.findIndex((s) => !s.summary.some((e) => e.category === category));
    return Math.max(0, none);
  }
  let index = $state(startIndex());
  // The card's analysis can change while open (a live update): stay in range.
  const at = $derived(Math.min(index, Math.max(0, stills.length - 1)));
  const still = $derived(stills[at] ?? null);
  // ◀ ▶ wrap around: neither button is ever disabled, so focus never drops out of the dialog.
  const step = (d: -1 | 1) => (index = (at + d + stills.length) % stills.length);

  const enc = encodeURIComponent;
  const src = $derived(still ? `/api/cameras/${enc(cameraId)}/stills/${still.stillTs}.jpg` : '');
  const timelineHref = $derived(still ? `/app/timeline?cam=${enc(cameraId)}&date=${localDate(new Date(still.stillTs))}&t=${still.stillTs}` : '');
  const entries = $derived(still ? [...still.summary].sort((a, b) => b.score - a.score) : []);
  function loadAll(): Promise<StillObject[]> {
    const id = still!.eventId;
    return getJson<{ objects: StillObject[] }>(`/api/cameras/${enc(cameraId)}/analyses/${id}`).then((r) => r.objects);
  }

  // Focus: into the dialog on open and kept there by Tab, and brought back
  // when it lands outside while open (issue #113); the badge takes it back on
  // close (VisionBadges).
  let dialogEl: HTMLElement | undefined = $state();
  const focusables = () => [...(dialogEl?.querySelectorAll<HTMLElement>('button, input, select, a[href]') ?? [])].filter((e) => !e.hasAttribute('disabled'));
  onMount(() => {
    void tick().then(() => (focusables()[0] ?? dialogEl)?.focus());
  });
  // Closing hands focus back to the badge before the dialog goes: let it.
  let closing = false;
  function close() {
    closing = true;
    onclose();
  }
  function keepFocus(e: FocusEvent) {
    if (!closing && dialogEl && e.target instanceof Node && !dialogEl.contains(e.target)) (focusables()[0] ?? dialogEl).focus();
  }
  function trap(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
    e.preventDefault();
    f[next].focus();
  }
  // History at the still's second, paused, from the same shared cursor the
  // Timeline's "Open in History" leaves (Klaus, 2026-10-01).
  const historyLink = $derived(still ? historyHref(cameraId, still.stillTs) : '');
  // A plain click closes the dialog and stays in the app; a modified one is the browser's.
  function go(e: MouseEvent, open: () => void) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    close();
    open();
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />
<svelte:document onfocusin={keepFocus} />
<div class="layer" use:portal>
  <div class="backdrop" role="presentation" data-testid="vision-dialog-backdrop" onclick={close}></div>
  <div class="dialog" role="dialog" aria-modal="true" aria-label={`Vision: ${LABEL[category]}`} data-testid="vision-dialog" tabindex="-1" bind:this={dialogEl} onkeydown={trap}>
    <header>
      <h2>✦ Vision · {LABEL[category]}{#if still}<span class="time">{clock(still.stillTs)}</span>{/if}</h2>
      <button class="x" aria-label="Close" data-testid="vision-dialog-close" onclick={close}>✕</button>
    </header>
    {#if still}
      <TimelineStill {src} alt={`The analysed still at ${clock(still.stillTs)}`} summary={still.summary} {loadAll} />
      {#if stills.length > 1}
        <div class="steps">
          <button data-testid="vision-dialog-prev" aria-label="Previous analysed still" onclick={() => step(-1)}>◀</button>
          <span>{at + 1} of {stills.length}</span>
          <button data-testid="vision-dialog-next" aria-label="Next analysed still" onclick={() => step(1)}>▶</button>
        </div>
      {/if}
      {#if entries.length}
        <ul class="found">
          {#each entries as e, i (i)}<li>{findingLine(e.subtype, e.score)}</li>{/each}
        </ul>
      {:else}
        <p class="muted">Vision found nothing relevant in this still.</p>
      {/if}
      <footer>
        <a href={historyLink} data-testid="vision-dialog-history" onclick={(e) => go(e, () => openHistory(cameraId, still!.stillTs))}>Open in History</a>
        <a href={timelineHref} data-testid="vision-dialog-timeline" onclick={(e) => go(e, () => navigate(timelineHref))}>Open in Timeline</a>
      </footer>
    {:else}
      <p class="muted">No still was kept for this analysis.</p>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: var(--scrim); z-index: 40; }
  .dialog { position: fixed; z-index: 41; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(720px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 18px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); color: var(--text); font-size: 14px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  h2 { margin: 0; font-size: 17px; }
  .time { margin-left: 10px; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
  .x { border: 0; background: transparent; color: var(--muted); font-size: 16px; cursor: pointer; }
  .steps { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
  .steps button { padding: 2px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  .found { margin: 0; padding-left: 18px; font-size: 13px; }
  .muted { margin: 0; color: var(--muted); font-size: 13px; }
  footer { display: flex; justify-content: flex-end; gap: 16px; }
  footer a { color: var(--accent); font-size: 13px; }
</style>
