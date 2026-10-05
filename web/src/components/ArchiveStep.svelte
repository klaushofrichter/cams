<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import LabelChips from './LabelChips.svelte';
  import RetentionField from './RetentionField.svelte';
  import { ArchiveError, cancelArchiveJob, createArchive, DEFAULT_RETENTION_DAYS, defaultName, errorText, formatBytes, itemKey, nameProblem, normalizeLabels, pollArchiveJob, preselectLabels, retentionProblem, type ArchiveItem, type ArchiveJob, type ArchiveSource } from '../lib/archive';
  import { navigate } from '../lib/router';

  // The Save dialog's archive step (cams spec 2026-10-05-archive-design): the
  // clip the dialog would save, kept on the camera's cam-proxy apart from
  // retention. Name (the proxy's default unless edited), retention, labels
  // (preselected from the clip's kinds and size), then Archive → progress →
  // done. Cancel goes back to the Save dialog. A job keeps running when the
  // dialog closes (the proxy finishes it without polling, contract §2).
  let { camera, cameraName, source, recordedFrom, kinds, size, thumbnailAt, oncancel, onclose }: {
    camera: string;
    cameraName: string;
    source: ArchiveSource;
    recordedFrom: number;
    kinds: readonly string[];
    size: string;
    thumbnailAt?: number;
    oncancel: () => void;
    onclose: () => void;
  } = $props();

  const initialName = untrack(() => defaultName(recordedFrom, cameraName));
  let name = $state(initialName);
  let labels = $state(untrack(() => preselectLabels(kinds, size)));
  let days = $state<number | null>(DEFAULT_RETENTION_DAYS);
  let phase = $state<'form' | 'sending' | 'progress' | 'done'>('form');
  let job = $state<ArchiveJob | null>(null);
  let item = $state<ArchiveItem | null>(null);
  let error = $state('');
  let timer: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  let nameEl: HTMLInputElement | undefined = $state();
  onMount(() => void tick().then(() => nameEl?.focus()));
  onDestroy(() => clearInterval(timer));

  const problem = $derived(nameProblem(name) ?? retentionProblem(days) ?? (normalizeLabels(labels).ok ? null : 'Check the labels.'));

  async function archive() {
    if (problem || phase !== 'form') return;
    error = '';
    phase = 'sending';
    try {
      // The proxy names it in the camera's clock when the name is left as it was (ruling 3).
      const j = await createArchive(camera, { source, labels, retentionDays: days, ...(name.trim() !== initialName ? { name: name.trim() } : {}), ...(thumbnailAt !== undefined ? { thumbnailAt } : {}) });
      follow(j);
    } catch (e) {
      phase = 'form';
      error = (e as Error).message;
    }
  }
  function follow(j: ArchiveJob) {
    job = j;
    if (j.state === 'done' && j.item) {
      item = j.item;
      phase = 'done';
      return;
    }
    if (j.state === 'failed' || j.state === 'cancelled') {
      phase = 'form';
      error = errorText(j.error, { detail: j.detail });
      return;
    }
    phase = 'progress';
    clearInterval(timer);
    failures = 0;
    timer = setInterval(() => void poll(j.via, j.id), 1500);
  }
  async function poll(via: string, id: string) {
    let j: ArchiveJob | null;
    try {
      j = await pollArchiveJob(via, id);
    } catch (e) {
      if (++failures < 5 && !(e instanceof ArchiveError && e.status < 500)) return;
      clearInterval(timer);
      phase = 'form';
      error = 'The cam-proxy stopped answering; the clip may still be archived. Look on the Archive page.';
      return;
    }
    if (job?.id !== id) return;
    if (!j) {
      clearInterval(timer);
      phase = 'form';
      error = 'The archive job is gone; look on the Archive page whether the clip is there.';
      return;
    }
    if (j.state !== 'queued' && j.state !== 'running') clearInterval(timer);
    follow(j);
  }
  function cancelJob() {
    clearInterval(timer);
    if (job) cancelArchiveJob(job.via, job.id);
    job = null;
    phase = 'form';
    error = 'Archiving was cancelled.';
  }
  function openInArchive() {
    if (!item) return;
    onclose();
    navigate(`/app/archive?item=${encodeURIComponent(itemKey(item))}`);
  }
  const phaseText: Record<string, string> = { fetching: 'Fetching the recording from the camera…', copying: 'Copying…', finishing: 'Finishing…' };
</script>

<div class="step" data-testid="archive-step">
  {#if phase === 'done' && item}
    <p class="done" data-testid="archive-done" role="status">Archived as “{item.name}” ({formatBytes(item.bytes)}).</p>
    <footer>
      <button data-testid="archive-close" onclick={onclose}>Close</button>
      <button class="primary" data-testid="archive-open" onclick={openInArchive}>Open in Archive</button>
    </footer>
  {:else}
    <p class="muted" data-testid="archive-intro">Keeps this clip on {cameraName}’s cam-proxy, apart from the normal retention.</p>
    <label class="field">Name
      <input type="text" data-testid="archive-name" maxlength="120" bind:value={name} bind:this={nameEl} disabled={phase !== 'form'} />
    </label>
    <div class="field">Retention
      <RetentionField bind:days testid="archive-retention" />
    </div>
    <div class="field">Labels
      <LabelChips bind:labels testid="archive-labels" />
    </div>
    {#if problem && phase === 'form'}<p class="err" data-testid="archive-problem">{problem}</p>{/if}
    {#if phase === 'progress' || phase === 'sending'}
      <p class="muted" data-testid="archive-progress-text" role="status">{phase === 'sending' ? 'Starting…' : job?.state === 'queued' ? 'Queued…' : (phaseText[job?.phase ?? ''] ?? 'Archiving…')}{job?.size ? ` ${formatBytes(job.bytes ?? 0)} of ${formatBytes(job.size)}` : ''}</p>
      <progress data-testid="archive-progress" aria-label="Archiving" max="1" value={job?.progress ?? 0}></progress>
    {/if}
    {#if error}<p class="err" role="alert" data-testid="archive-error">{error}</p>{/if}
    <footer>
      {#if phase === 'progress'}
        <button data-testid="archive-cancel-job" onclick={cancelJob}>Cancel archiving</button>
      {:else}
        <button data-testid="archive-cancel" disabled={phase === 'sending'} onclick={oncancel}>Cancel</button>
        <button class="primary" data-testid="archive-submit" disabled={!!problem || phase !== 'form'} onclick={archive}>Archive</button>
      {/if}
    </footer>
  {/if}
</div>

<style>
  .step { display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
  .field { display: grid; gap: 6px; }
  .field > input { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  progress { width: 100%; }
  .muted { margin: 0; color: var(--muted); }
  .err { margin: 0; color: var(--danger); }
  .done { margin: 0; }
  footer { display: flex; justify-content: flex-end; gap: 8px; }
  footer button { padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  footer button.primary { background: var(--grad); color: var(--on-grad); border: 0; }
  footer button:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
