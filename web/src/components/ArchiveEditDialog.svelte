<script lang="ts">
  import { untrack } from 'svelte';
  import LabelChips from './LabelChips.svelte';
  import Modal from './Modal.svelte';
  import RetentionField from './RetentionField.svelte';
  import { applyLabelStates, eachLimited, itemKey, labelStates, nameProblem, normalizeLabels, patchItem, retentionProblem, sameLabels, type ArchiveItem, type EditMode, type Patch, type Tri } from '../lib/archive';

  // Edit one archived clip (name, labels, retention), or set the labels or
  // the retention of many (cams spec 2026-10-05-archive-design). Each clip is
  // one PATCH (the contract has no bulk edit), four at a time; only what
  // changed is sent.
  let { mode, onclose, onsaved }: { mode: EditMode; onclose: () => void; onsaved: (items: ArchiveItem[]) => void } = $props();

  const m = untrack(() => mode);
  const items = m.kind === 'one' ? [m.item] : m.items;
  let name = $state(m.kind === 'one' ? m.item.name : '');
  let labels = $state(m.kind === 'one' ? [...m.item.labels] : []);
  let states = $state<Map<string, Tri>>(labelStates(items));
  const commonDays = items.every((x) => x.retentionDays === items[0].retentionDays) ? items[0].retentionDays : 365;
  let days = $state<number | null>(commonDays);
  let busy = $state(false);
  let error = $state('');

  const title = m.kind === 'one' ? 'Edit clip' : m.kind === 'labels' ? `Set labels of ${items.length} clip${items.length === 1 ? '' : 's'}` : `Set retention of ${items.length} clip${items.length === 1 ? '' : 's'}`;
  const problem = $derived(
    m.kind === 'one' ? (nameProblem(name) ?? retentionProblem(days) ?? (normalizeLabels(labels).ok ? null : 'Check the labels.'))
    : m.kind === 'retention' ? retentionProblem(days)
    : null,
  );

  function patchOf(x: ArchiveItem): Patch {
    const p: Patch = {};
    if (m.kind === 'one') {
      if (name.trim() !== x.name) p.name = name.trim();
      if (!sameLabels(labels, x.labels)) p.labels = labels;
      if (days !== x.retentionDays) p.retentionDays = days;
    } else if (m.kind === 'labels') {
      const next = applyLabelStates(x.labels, states);
      if (!sameLabels(next, x.labels)) p.labels = next;
    } else if (days !== x.retentionDays) p.retentionDays = days;
    return p;
  }
  async function save() {
    if (problem || busy) return;
    busy = true;
    error = '';
    const done: ArchiveItem[] = [];
    const errors = await eachLimited(items, 4, async (x) => {
      const p = patchOf(x);
      if (Object.keys(p).length) done.push(await patchItem(x, p));
    });
    busy = false;
    if (done.length) onsaved(done);
    if (errors.length) {
      error = errors.length === 1 ? errors[0] : `${errors.length} clips could not be changed: ${errors[0]}`;
      return;
    }
    onclose();
  }
</script>

<Modal {title} testid="archive-edit-dialog" {onclose}>
  <div class="form" data-testid="archive-edit-form" data-keys={items.map(itemKey).join(' ')}>
    {#if m.kind === 'one'}
      <label class="field">Name <input type="text" data-testid="archive-edit-name" maxlength="120" bind:value={name} data-autofocus /></label>
    {/if}
    {#if m.kind !== 'retention'}
      <div class="field">Labels
        {#if m.kind === 'one'}<LabelChips bind:labels testid="archive-edit-labels" />{:else}<LabelChips bind:states testid="archive-edit-labels" />{/if}
      </div>
    {/if}
    {#if m.kind !== 'labels'}
      <div class="field">Keep (from when it was archived)
        <RetentionField bind:days testid="archive-edit-retention" />
      </div>
    {/if}
    {#if problem}<p class="err" data-testid="archive-edit-problem">{problem}</p>{/if}
    {#if error}<p class="err" role="alert" data-testid="archive-edit-error">{error}</p>{/if}
    <footer>
      <button data-testid="archive-edit-cancel" onclick={onclose}>Cancel</button>
      <button class="primary" data-testid="archive-edit-save" disabled={!!problem || busy} onclick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </footer>
  </div>
</Modal>

<style>
  .form { display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
  .field { display: grid; gap: 6px; }
  .field > input { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  .err { margin: 0; color: var(--danger); }
  footer { display: flex; justify-content: flex-end; gap: 8px; }
  footer button { padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  footer button.primary { background: var(--grad); color: var(--on-grad); border: 0; }
  footer button:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
