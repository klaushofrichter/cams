<script lang="ts">
  import { labelProblem, labelSpelling, MAX_LABELS, PREDEFINED_LABELS, type Tri } from '../lib/archive';

  // An archived clip's labels (cam-proxy's archive contract §1): the five
  // predefined ones as toggles, custom ones as chips with ✕, and a field to
  // add one word. With `states` (Set labels on many clips) each chip is on
  // for all, for some (dashed, each clip keeps its own) or for none; a click
  // makes it all or none.
  let { labels = $bindable([]), states = $bindable(), testid = 'labels' }: { labels?: string[]; states?: Map<string, Tri>; testid?: string } = $props();

  let typed = $state('');
  let problem = $state('');
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const isPredefined = (l: string) => PREDEFINED_LABELS.some((p) => same(p, l));
  const stateOf = (l: string): Tri => (states ? ([...states].find(([k]) => same(k, l))?.[1] ?? 'none') : labels.some((x) => same(x, l)) ? 'all' : 'none');
  const custom = $derived(states ? [...states.keys()].filter((l) => !isPredefined(l)) : labels.filter((l) => !isPredefined(l)));
  const count = $derived(states ? [...states.values()].filter((s) => s !== 'none').length : labels.length);

  function set(l: string, on: boolean) {
    if (states) {
      const next = new Map(states);
      const k = [...next.keys()].find((x) => same(x, l)) ?? l;
      next.set(k, on ? 'all' : 'none');
      states = next;
    } else labels = on ? [...labels.filter((x) => !same(x, l)), l] : labels.filter((x) => !same(x, l));
  }
  const toggle = (l: string) => set(l, stateOf(l) !== 'all');
  function remove(l: string) {
    if (states) {
      const next = new Map(states);
      const k = [...next.keys()].find((x) => same(x, l));
      if (k) next.set(k, 'none');
      states = next;
    } else labels = labels.filter((x) => !same(x, l));
  }
  function add() {
    const t = typed.trim();
    const p = labelProblem(t);
    if (p) return void (problem = p);
    if (stateOf(t) === 'all') return void ((typed = ''), (problem = ''));
    if (count >= MAX_LABELS) return void (problem = `At most ${MAX_LABELS} labels.`);
    set(labelSpelling(t), true);
    typed = '';
    problem = '';
  }
</script>

<div class="labels" data-testid={testid}>
  <div class="chips" role="group" aria-label="Labels">
    {#each PREDEFINED_LABELS as l (l)}
      {@const s = stateOf(l)}
      <button type="button" class="chip" class:on={s === 'all'} class:some={s === 'some'} aria-pressed={s === 'all' ? 'true' : s === 'some' ? 'mixed' : 'false'} data-testid="label-chip" data-label={l} onclick={() => toggle(l)}>{l}</button>
    {/each}
    {#each custom as l (l)}
      {@const s = stateOf(l)}
      {#if s !== 'none' || states}
        <span class="chip custom" class:on={s === 'all'} class:some={s === 'some'} class:off={s === 'none'} data-testid="label-custom" data-label={l}>
          {#if states}<button type="button" class="name" aria-pressed={s === 'all' ? 'true' : s === 'some' ? 'mixed' : 'false'} onclick={() => toggle(l)}>{l}</button>{:else}{l}{/if}
          {#if s !== 'none'}<button type="button" class="rm" aria-label={`Remove ${l}`} data-testid="label-remove" onclick={() => remove(l)}>✕</button>{/if}
        </span>
      {/if}
    {/each}
  </div>
  <div class="add">
    <input type="text" data-testid="label-input" placeholder="Add a label (one word)" aria-label="Add a label" maxlength="24" bind:value={typed} oninput={() => (problem = '')} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
    <button type="button" data-testid="label-add" onclick={add}>Add</button>
  </div>
  {#if problem}<p class="err" role="alert" data-testid="label-error">{problem}</p>{/if}
  {#if states}<p class="muted">Dashed: on some of the clips; left so, each keeps its own.</p>{/if}
</div>

<style>
  .labels { display: grid; gap: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
  .chip.on { background: color-mix(in srgb, var(--accent) 22%, transparent); border-color: var(--accent); color: var(--text); }
  .chip.some { border-style: dashed; border-color: var(--accent); color: var(--text); }
  .chip.custom { cursor: default; padding-right: 4px; }
  .chip.off { opacity: 0.7; }
  .name { border: 0; background: transparent; color: inherit; font: inherit; padding: 0; cursor: pointer; }
  .rm { border: 0; background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; padding: 2px 4px; }
  .add { display: flex; gap: 6px; }
  .add input { flex: 1; min-width: 0; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; }
  .add button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  .err { margin: 0; color: var(--danger); font-size: 13px; }
  .muted { margin: 0; color: var(--muted); font-size: 12px; }
</style>
