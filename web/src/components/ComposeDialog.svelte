<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { triggerDownload } from '../lib/download';
  import { downloadUrl, formatClock, orderTriggers, thumbUrl, TRIGGER_LABELS, type EventClip } from '../lib/recordings';
  import { aroundLength, aroundPreset, aroundRanges, cancelJob, composedName, formatSeconds, generateMaxS, madeOf, PLAIN_MAX_S, planAround, rollKeyStep, rollValueText, secondsPast, sliderBounds, fullQualityAvailable, isAvailable, isPlain, ORIGINAL_4K_LABEL, pollJob, presetRolls, resultLength, rollRange, saveMaxS, SIZE_LABELS, snapRoll, startJob, videoUrl, type AroundPlan, type ComposeSize, type JobView, type RollRange, type SaveSize } from '../lib/compose';
  import { localClock } from '../lib/clock';

  // Every download of a clip goes through this dialog (Klaus, 2026-09-29): SD
  // or 4K as recorded, or, with a cam-proxy, SD sizes with a pre-/post-roll
  // (cam-proxy spec 2026-09-28). `composable`: the camera has a cam-proxy in use.
  // `at` instead of `clip` (#179 phase 3, "Save clip around this"): the
  // window around a second (unix ms), composed by the cam-proxy from its FTP
  // clips and stills; `stillSrc` is that second's still. Always generated:
  // rolls 0 or more at every size, no 4K, no plain save.
  let { camera, clip, at, stillSrc, onclose, composable = true }: { camera: string; clip?: EventClip; at?: number; stillSrc?: string; onclose: () => void; composable?: boolean } = $props();
  const around = untrack(() => at !== undefined);
  // The seconds already past after `at`: the proxy composes only a window
  // that has ended, so the post-roll stops there. It grows while the dialog
  // is open (once a second) and is taken again on Generate (review of #190).
  let pastS = $state(untrack(() => (at !== undefined ? secondsPast(at, Date.now()) : 0)));
  const refreshPast = () => {
    if (at !== undefined) pastS = secondsPast(at, Date.now());
  };
  // The second's still; hidden when it doesn't load (a gap, review of #190).
  let stillFailed = $state(false);
  const clipS = $derived(around ? 1 : clip!.durationSec);

  // A clip longer than even a plain save opens cut at its end to the
  // generated limit, and says so (Klaus, 2026-10-04). Around a second: -10/+10.
  const preset = untrack(() => (around ? { ...aroundPreset(pastS), note: '' } : presetRolls(clip!.durationSec)));
  let preS = $state(preset.preS);
  let postS = $state(preset.postS);
  let badge = $state(true);
  let size = $state<SaveSize>('sd');
  let job = $state<JobView | null>(null);
  let error = $state('');
  let timer: ReturnType<typeof setInterval> | undefined;
  let keep: ReturnType<typeof setInterval> | undefined; // keeps a finished result alive

  // 4K is the camera's original: no pre- or post-roll.
  const is4k = $derived(size === '4k');
  // Whether the full-resolution file can be served now; asked whenever 4K is
  // chosen, and again on Save (the download itself can't show a failure). No
  // silent quality downgrade (Klaus, 2026-10-02): when it can't, 4K's Save is
  // off and the standard quality is offered instead. A late answer for
  // another clip or a changed choice is dropped.
  let fullOk = $state(true);
  let askSeq = 0;
  async function askFull(): Promise<boolean> {
    const seq = ++askSeq;
    const id = clip!.id;
    const a = await fullQualityAvailable(camera, id);
    if (seq === askSeq && id === clip!.id && is4k) fullOk = a;
    return a && seq === askSeq && id === clip!.id && is4k;
  }
  // Only with a cam-proxy: a camera without one saves 4K exactly as before
  // (no question, the plain <a download>, which keeps the user's tap on iOS).
  $effect(() => {
    const on = is4k && composable;
    untrack(() => (on ? void askFull() : void askSeq++));
  });
  // The browser's download can't report a refusal, so 4K's Save asks first
  // and then starts the download itself (never buffered into a blob).
  function onSave(e: MouseEvent) {
    if (!is4k || !composable) return;
    e.preventDefault();
    if (fullMissing || !length.ok) return;
    const href = downloadUrl(camera, clip!.id, 'main');
    void askFull().then((ok) => {
      if (ok) triggerDownload(href);
    });
  }
  const fullMissing = $derived(is4k && !fullOk);
  // Pre- and post-roll are for SD only (Klaus, 2026-09-29): other sizes save
  // or resize the clip alone.
  const rollOff = $derived(!around && size !== 'sd');
  const roll = $derived(rollOff ? { pre: 0, post: 0 } : { pre: Number(preS), post: Number(postS) });
  // The limit that applies (server/clipLimits.ts): 600 s for a plain save
  // (SD or 4K as recorded), 300 s for a generated clip, 120 s at 1080p.
  const maxS = $derived(around ? generateMaxS(size) : saveMaxS(size, roll.pre, roll.post));
  const length = $derived(
    !around ? resultLength(clipS, roll.pre, roll.post, maxS)
    : Number.isInteger(roll.post) && roll.post > pastS ? { ok: false as const, error: `At most ${pastS} s after: the clip can only end at a second already past` }
    : aroundLength(roll.pre, roll.post, size),
  );
  const plain = $derived(!around && isPlain(size, roll.pre, roll.post));
  // The limit only when it matters (Klaus, 2026-10-04): a generated clip
  // (300 s, 120 s at 1080p) or a recording longer than a plain save.
  const showLimit = $derived(!plain || clipS > PLAIN_MAX_S);
  // The sliders' ranges: each given the other roll, never past the limit
  // (around a second: 0 or more, the post-roll within the seconds past).
  const ar = $derived(aroundRanges(Number(preS) || 0, Number(postS) || 0, size, pastS));
  const preRange = $derived(around ? ar.pre : rollRange(clipS, Number(postS) || 0, size));
  const postRange = $derived(around ? ar.post : rollRange(clipS, Number(preS) || 0, size));
  // The tracks are fixed (sliderBounds); a drag past what the other roll
  // leaves is clamped, and the thumb put back where the value is.
  const track = $derived(sliderBounds(clipS, size));
  const preTrack = $derived(around ? ar.preTrack : track);
  const postTrack = $derived(around ? ar.postTrack : track);
  function slide(e: Event, range: RollRange, put: (v: number) => void) {
    const el = e.currentTarget as HTMLInputElement;
    const v = snapRoll(Number(el.value), range);
    put(v);
    el.value = String(v);
  }
  const slidePre = (e: Event) => slide(e, preRange, (v) => (preS = v));
  const slidePost = (e: Event) => slide(e, postRange, (v) => (postS = v));
  // ← / → as the thumb looks: on the reversed pre-roll slider ← is an
  // earlier start (rollKeyStep), clamped like a drag.
  function stepKey(e: KeyboardEvent, which: 'pre' | 'post') {
    const d = rollKeyStep(which, e.key);
    if (d === null) return;
    e.preventDefault();
    if (which === 'pre') preS = snapRoll((Number(preS) || 0) + d, preRange);
    else postS = snapRoll((Number(postS) || 0) + d, postRange);
  }
  const ready = $derived(job?.state === 'done');
  const busy = $derived(job?.state === 'queued' || job?.state === 'running');
  // Around a second the cams server names the file in the camera's time
  // (ruling 16) and sends it with the job.
  const name = $derived(around ? (job?.name ?? `${camera}-around.mp4`) : composedName(camera, clip!.id, (is4k ? 'sd' : size) as ComposeSize));

  // Whether the proxy has a copy of this clip at all (issue #72): without
  // one, only the plain save is offered.
  let available = $state(true);
  let presetNote = $state(preset.note);
  // Only SD and 4K as recorded: no cam-proxy, or it has no copy of this clip.
  const simple = $derived(!around && (!composable || !available));
  const sizes = $derived<[SaveSize, string][]>(simple
    ? [['sd', SIZE_LABELS.sd], ['4k', ORIGINAL_4K_LABEL]]
    : around ? (Object.entries(SIZE_LABELS) as [SaveSize, string][])
    : [...(Object.entries(SIZE_LABELS) as [SaveSize, string][]), ['4k', ORIGINAL_4K_LABEL]]);
  // A size the list no longer offers (the proxy answered "no copy") falls back
  // to SD, and a pre-/post-roll typed meanwhile is dropped with its hidden
  // fields: no Generate for settings that can't be seen (issue #76).
  $effect(() => {
    if (!sizes.some(([k]) => k === size)) size = 'sd';
    if (simple) {
      preS = postS = 0;
      presetNote = '';
    }
  });
  let dialogEl: HTMLElement | undefined = $state();
  // Focus: into the dialog on open, kept inside by Tab, back to where it was
  // on close (issue #72).
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  const focusables = () => [...(dialogEl?.querySelectorAll<HTMLElement>('button, input, select, a[href]') ?? [])].filter((e) => !e.hasAttribute('disabled'));
  onMount(() => {
    void tick().then(() => focusables()[0]?.focus());
    if (composable && !around) void isAvailable(camera, clip!.id).then((a) => (available = a));
    const past = around ? setInterval(refreshPast, 1000) : undefined;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        if (job || starting) hiddenAt ??= Date.now(); // only a hide while a job runs counts
      }
      else if (job) void poll(gen, job.id);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(past);
      document.removeEventListener('visibilitychange', onVisible);
    };
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

  // Around a second: what the clip will be made of, from a dry run 300 ms
  // after the last change (ruling 15); "nothing" turns Generate off, a failed
  // dry run shows no line.
  let plan = $state<{ key: string; plan: AroundPlan | 'nothing' } | null>(null);
  const planKey = $derived(`${roll.pre}|${roll.post}|${size}`);
  $effect(() => {
    if (!around || !length.ok || size === '4k') return;
    const key = planKey;
    const q = { at: at!, preS: roll.pre, postS: roll.post, size: size as ComposeSize };
    const t = setTimeout(() => {
      void planAround(camera, q).then((r) => {
        if (key !== planKey) return;
        plan = r.kind === 'plan' ? { key, plan: r.plan } : r.kind === 'nothing' ? { key, plan: 'nothing' } : null;
      });
    }, 300);
    return () => clearTimeout(t);
  });
  const shownPlan = $derived(plan && plan.key === planKey && length.ok ? plan.plan : null);
  const nothing = $derived(shownPlan === 'nothing');
  const title = $derived(around ? `Save clip around ${localClock(at!)}` : 'Save clip');

  // Each Generate, Cancel, edit or Close is a new generation: an answer that
  // arrives for an older one (a start or a poll) is dropped, and a job it
  // started is cancelled (final review).
  let gen = 0;
  let starting = $state(false);
  let failures = 0;
  const MAX_FAILURES = 5;
  // When the page went into the background, until a poll after it finds the
  // job still there: a job gone meanwhile was stopped "in the background",
  // whichever poll notices first (issue #76).
  let hiddenAt: number | null = null;

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
    if (starting || busy || size === '4k') return; // 4K is saved as it is, never composed
    refreshPast();
    if (!length.ok) return; // the post-roll past the seconds past, say
    stop();
    error = '';
    const mine = gen;
    starting = true;
    hiddenAt = document.visibilityState === 'hidden' ? Date.now() : null;
    let started: JobView;
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      started = await startJob(camera, around
        ? { at: at!, preS: roll.pre, postS: roll.post, size: size as ComposeSize, badge, timeZone }
        : { eventId: clip!.id, preS: roll.pre, postS: roll.post, size: size as ComposeSize, badge, timeZone });
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
  async function poll(mine: number, id: string) {
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
    const fromBackground = hiddenAt !== null;
    if (document.visibilityState === 'visible') hiddenAt = null;
    if (!v) {
      clearInterval(timer);
      clearInterval(keep);
      keep = undefined;
      error = fromBackground ? 'The composition stopped while the page was in the background; generate it again.' : 'The composition was lost; try again.';
      job = null;
      return;
    }
    job = { ...v, ...(job?.name ? { name: job.name } : {}) };
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
<div class="dialog" role="dialog" aria-modal="true" aria-label={title} data-testid="compose-dialog" tabindex="-1" bind:this={dialogEl} onkeydown={trap}>
  <header>
    <h2>{title}</h2>
    <button class="x" data-testid="compose-close" aria-label="Close" onclick={close}>✕</button>
  </header>
  {#if around}
    <div class="clip">
      {#if stillSrc && !stillFailed}<img data-testid="compose-thumb" src={stillSrc} alt="" onerror={() => (stillFailed = true)} />{/if}
      <span>{localClock(at!)} · {Number(preS) || 0} s before, {Number(postS) || 0} s after</span>
    </div>
  {:else if clip}
    <div class="clip">
      <img data-testid="compose-thumb" src={thumbUrl(camera, clip.id, clip.thumb)} alt="" />
      <span>{formatClock(clip.start)} · {formatSeconds(clip.durationSec)} · {orderTriggers(clip.triggers).map((t) => TRIGGER_LABELS[t]).join(', ')}</span>
    </div>
  {/if}
  {#if composable && !available}
    <p class="muted" data-testid="compose-unavailable">The cam-proxy has no copy of this clip, so it can only be saved as it is.</p>
  {/if}
  <div class="fields">
    {#if !simple}
      <!-- Number and slider show the same roll; a negative one cuts the clip
           (pre-roll at its start, post-roll at its end). -->
      <!-- The pre-roll slider runs right to left (Klaus, 2026-10-04): filled at
           the right, left is an earlier start; the post-roll slider fills from
           the left, right adds. Together: the window around the clip. -->
      <label>Pre-roll (s) <input type="number" data-testid="compose-pre" min={preRange.min} max={preRange.max} step="1" disabled={rollOff} bind:value={preS} />
        <input type="range" dir="rtl" data-testid="compose-pre-slider" aria-label="Pre-roll (s)" aria-valuetext={rollValueText('pre', rollOff ? 0 : Number(preS) || 0)}
          min={preTrack.min} max={preTrack.max} step="1" disabled={rollOff} value={rollOff ? 0 : Number(preS) || 0} oninput={slidePre} onkeydown={(e) => stepKey(e, 'pre')} /></label>
      <label>Post-roll (s) <input type="number" data-testid="compose-post" min={postRange.min} max={postRange.max} step="1" disabled={rollOff} bind:value={postS} />
        <input type="range" data-testid="compose-post-slider" aria-label="Post-roll (s)" aria-valuetext={rollValueText('post', rollOff ? 0 : Number(postS) || 0)}
          min={postTrack.min} max={postTrack.max} step="1" disabled={rollOff} value={rollOff ? 0 : Number(postS) || 0} oninput={slidePost} onkeydown={(e) => stepKey(e, 'post')} /></label>
    {/if}
    <label>Size
      <select data-testid="compose-size" bind:value={size}>
        {#each sizes as [k, label] (k)}<option value={k}>{label}</option>{/each}
      </select>
    </label>
    {#if !simple}
      <label class="row"><input type="checkbox" data-testid="compose-badge" disabled={rollOff} bind:checked={badge} /> Mark still sections</label>
    {/if}
  </div>
  {#if presetNote && !rollOff && Number(preS) === preset.preS && Number(postS) === preset.postS}
    <p class="muted" data-testid="compose-preset-note">{presetNote}</p>
  {/if}
  {#if !simple && rollOff}
    <p class="muted" data-testid="compose-roll-note">Pre- and post-roll are available only for SD quality.</p>
  {/if}
  {#if is4k}
    <p class="muted" data-testid="compose-4k-note">4K saves the camera's original recording as it is.</p>
  {/if}
  {#if fullMissing}
    <p class="err" data-testid="compose-4k-unavailable" role="alert">The full-resolution file isn't available right now; download the standard quality instead.</p>
    <button class="link" data-testid="compose-use-sd" onclick={() => (size = 'sd')}>Use the standard quality</button>
  {/if}
  {#if simple && clipS > PLAIN_MAX_S}
    <p class="muted" data-testid="compose-too-long-note">This recording is {formatSeconds(clipS)}. A save as it is can be at most {formatSeconds(PLAIN_MAX_S)}, and only a cam-proxy copy can be cut, so it can’t be saved here.</p>
  {/if}
  {#if length.ok}
    <p class="muted" data-testid="compose-length" role="status">Result: {formatSeconds(length.seconds)}{showLimit ? ` · at most ${formatSeconds(maxS)}` : ''}</p>
  {:else}
    <p class="err" data-testid="compose-error" role="status">{length.error}</p>
  {/if}
  {#if around && length.ok && shownPlan && shownPlan !== 'nothing'}
    <p class="muted" data-testid="compose-made-of">Made of: {madeOf(shownPlan, (t) => localClock(t))}</p>
  {/if}
  {#if around && length.ok && nothing}
    <p class="err" data-testid="compose-nothing" role="status">Nothing is kept around this second (stills and clips are kept 7 days).</p>
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
    {:else if !plain && length.ok && !nothing}
      <button data-testid="compose-generate" disabled={starting} onclick={generate}>{starting ? 'Starting…' : ready ? 'Generate again' : 'Generate'}</button>
    {/if}
    <a data-testid="compose-save" class="primary" download onclick={onSave}
      href={fullMissing ? undefined : plain ? (length.ok ? downloadUrl(camera, clip!.id, is4k ? 'main' : 'sub') : undefined) : ready && job ? videoUrl(camera, job.id, false, name) : undefined}
      aria-disabled={!fullMissing && ((plain && length.ok) || ready) ? 'false' : 'true'}>Save</a>
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
  input[type='range'] { width: 100%; margin: 2px 0 0; accent-color: var(--accent); }
  input[type='number'], select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  /* Pre-/post-roll off for sizes other than SD: dimmed, label included. */
  input:disabled { opacity: 0.45; cursor: not-allowed; }
  .fields label:has(input:disabled) { color: var(--muted); }
  progress { width: 100%; }
  video { width: 100%; border-radius: 8px; background: #000; }
  .muted { margin: 0; color: var(--muted); font-size: 13px; }
  .link { align-self: flex-start; padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; font-size: 13px; text-decoration: underline; cursor: pointer; }
  .err { margin: 0; color: var(--danger); font-size: 13px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; }
  footer button, footer a { padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
  footer a.primary { background: var(--grad); color: var(--on-grad); border: 0; }
  footer a[aria-disabled='true'] { opacity: 0.45; pointer-events: none; }
</style>
