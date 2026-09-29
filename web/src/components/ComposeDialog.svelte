<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { downloadUrl, formatClock, thumbUrl, TRIGGER_LABELS, type EventClip } from '../lib/recordings';
  import { cancelJob, composedName, formatLength, isAvailable, pollJob, resultLength, SIZE_LABELS, startJob, videoUrl, type ComposeSize, type JobView } from '../lib/compose';

  // The SD download with pre-/post-roll (cam-proxy spec 2026-09-28).
  let { camera, clip, onclose }: { camera: string; clip: EventClip; onclose: () => void } = $props();

  let preS = $state(0);
  let postS = $state(0);
  let badge = $state(true);
  let size = $state<ComposeSize>('sd');
  let job = $state<JobView | null>(null);
  let error = $state('');
  let timer: ReturnType<typeof setInterval> | undefined;
  let keep: ReturnType<typeof setInterval> | undefined; // keeps a finished result alive

  const length = $derived(resultLength(clip.durationSec, Number(preS), Number(postS)));
  const plain = $derived(Number(preS) === 0 && Number(postS) === 0 && size === 'sd');
  const ready = $derived(job?.state === 'done');
  const busy = $derived(job?.state === 'queued' || job?.state === 'running');
  const name = $derived(composedName(camera, clip.id, size));

  // Whether the proxy has a copy of this clip at all (issue #72): without
  // one, only the plain save is offered.
  let available = $state(true);
  let dialogEl: HTMLElement | undefined = $state();
  // Focus: into the dialog on open, kept inside by Tab, back to where it was
  // on close (issue #72).
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  const focusables = () => [...(dialogEl?.querySelectorAll<HTMLElement>('button, input, select, a[href]') ?? [])].filter((e) => !e.hasAttribute('disabled'));
  onMount(() => {
    void tick().then(() => focusables()[0]?.focus());
    void isAvailable(camera, clip.id).then((a) => (available = a));
    const onVisible = () => {
      if (document.visibilityState === 'visible' && job) void poll(gen, job.id, true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });
  onDestroy(() => opener?.focus?.());
  function trap(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
    e.preventDefault();
    f[next].focus();
  }

  // Any change after a result (or while one is starting) makes it stale.
  let lastKey = '';
  $effect(() => {
    const key = `${preS}|${postS}|${badge}|${size}`;
    if (lastKey && key !== lastKey && (job || starting)) stop();
    lastKey = key;
  });

  // Each Generate, Cancel, edit or Close is a new generation: an answer that
  // arrives for an older one (a start or a poll) is dropped, and a job it
  // started is cancelled (final review).
  let gen = 0;
  let starting = $state(false);
  let failures = 0;
  const MAX_FAILURES = 5;

  function stop() {
    gen++;
    clearInterval(timer);
    clearInterval(keep);
    keep = undefined;
    starting = false;
    if (job) cancelJob(camera, job.id);
    job = null;
  }
  async function generate() {
    if (starting || busy) return;
    stop();
    error = '';
    const mine = gen;
    starting = true;
    let started: JobView;
    try {
      started = await startJob(camera, { eventId: clip.id, preS: Number(preS), postS: Number(postS), size, badge, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    } catch (e) {
      if (mine === gen) {
        starting = false;
        error = (e as Error).message;
      }
      return;
    }
    if (mine !== gen) return cancelJob(camera, started.id); // closed, cancelled or edited meanwhile
    starting = false;
    job = started;
    failures = 0;
    timer = setInterval(() => void poll(mine, started.id), 1000);
  }
  async function poll(mine: number, id: string, fromBackground = false) {
    let v: JobView | null;
    try {
      v = await pollJob(camera, id);
    } catch {
      if (mine !== gen) return;
      if (++failures < MAX_FAILURES) return; // a blip: try again
      error = "The proxy didn't answer; the clip was not composed.";
      stop();
      return;
    }
    if (mine !== gen || job?.id !== id) return; // an answer for a job we left
    failures = 0;
    if (!v) {
      clearInterval(timer);
      clearInterval(keep);
      keep = undefined;
      error = fromBackground ? 'The composition stopped while the page was in the background; generate it again.' : 'The composition was lost; try again.';
      job = null;
      return;
    }
    job = v;
    if (v.state === 'done' || v.state === 'failed') clearInterval(timer);
    // A result being looked at stays on the proxy: ask about it once a minute.
    if (v.state === 'done' && !keep) keep = setInterval(() => void poll(mine, id), 60_000);
    if (v.state === 'failed') error = 'The clip could not be composed.';
  }
  function close() {
    stop();
    onclose();
  }
  onDestroy(() => stop());
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} onbeforeunload={() => stop()} />
<div class="backdrop" role="presentation" onclick={close}></div>
<div class="dialog" role="dialog" aria-modal="true" aria-label="Save SD clip" data-testid="compose-dialog" tabindex="-1" bind:this={dialogEl} onkeydown={trap}>
  <header>
    <h2>Save SD clip</h2>
    <button class="x" data-testid="compose-close" aria-label="Close" onclick={close}>✕</button>
  </header>
  <div class="clip">
    <img data-testid="compose-thumb" src={thumbUrl(camera, clip.id)} alt="" />
    <span>{formatClock(clip.start)} · {clip.durationSec} s · {clip.triggers.map((t) => TRIGGER_LABELS[t]).join(', ')}</span>
  </div>
  {#if !available}
    <p class="muted" data-testid="compose-unavailable">The cam-proxy has no copy of this clip, so it can only be saved as it is.</p>
  {:else}
  <div class="fields">
    <label>Pre-roll (s) <input type="number" data-testid="compose-pre" min="-600" max="60" step="1" bind:value={preS} /></label>
    <label>Post-roll (s) <input type="number" data-testid="compose-post" min="-600" max="60" step="1" bind:value={postS} /></label>
    <label>Size
      <select data-testid="compose-size" bind:value={size}>
        {#each Object.entries(SIZE_LABELS) as [k, label] (k)}<option value={k}>{label}</option>{/each}
      </select>
    </label>
    <label class="row"><input type="checkbox" data-testid="compose-badge" bind:checked={badge} /> Mark still sections</label>
  </div>
  {/if}
  {#if length.ok}
    <p class="muted" data-testid="compose-length" role="status">Result: {formatLength(length.seconds)}</p>
  {:else}
    <p class="err" data-testid="compose-error" role="status">{length.error}</p>
  {/if}
  {#if busy}
    {#if job?.state === 'queued'}<p class="muted" data-testid="compose-queued">Queued…</p>{/if}
    <progress data-testid="compose-progress" aria-label="Composing" max="1" value={job?.progress ?? 0}></progress>
  {/if}
  {#if ready && job}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video data-testid="compose-player" src={videoUrl(camera, job.id, true)} controls playsinline></video>
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  <footer>
    {#if busy}
      <button data-testid="compose-cancel" onclick={stop}>Cancel</button>
    {:else if !plain && length.ok}
      <button data-testid="compose-generate" disabled={starting} onclick={generate}>{starting ? 'Starting…' : ready ? 'Generate again' : 'Generate'}</button>
    {/if}
    <a data-testid="compose-save" class="primary" download
      href={plain ? downloadUrl(camera, clip.id, 'sub') : ready && job ? videoUrl(camera, job.id, false, name) : undefined}
      aria-disabled={plain || ready ? 'false' : 'true'}>Save</a>
  </footer>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: var(--scrim); z-index: 40; }
  .dialog { position: fixed; z-index: 41; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 18px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); color: var(--text); }
  header { display: flex; justify-content: space-between; align-items: center; }
  h2 { margin: 0; font-size: 17px; }
  .x { border: 0; background: transparent; color: var(--muted); font-size: 16px; cursor: pointer; }
  .clip { display: flex; gap: 12px; align-items: center; font-size: 13px; color: var(--muted); }
  .clip img { width: 144px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: var(--no-thumb-bg); }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px; }
  .fields label { display: grid; gap: 4px; }
  .fields .row { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; }
  input[type='number'], select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  progress { width: 100%; }
  video { width: 100%; border-radius: 8px; background: #000; }
  .muted { margin: 0; color: var(--muted); font-size: 13px; }
  .err { margin: 0; color: var(--danger); font-size: 13px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; }
  footer button, footer a { padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
  footer a.primary { background: var(--grad); color: var(--on-grad); border: 0; }
  footer a[aria-disabled='true'] { opacity: 0.45; pointer-events: none; }
</style>
