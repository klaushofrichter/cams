<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import { dateTime, durationText, expiresText, formatBytes, getMetadata, qualityText, type ArchiveItem, type ArchiveMetadata } from '../lib/archive';
  import { formatClock, pad2, TRIGGER_LABELS, type Trigger } from '../lib/recordings';
  import { cameraById } from '../lib/stores';

  // An archived clip (cams spec 2026-10-05-archive-design): its video through
  // cams's relay (ranges, so seeking and iOS work), play/pause, a mini
  // timeline, ±1 and ±10 s, and what was archived with it: events, Vision's
  // objects, labels, the source window, sizes.
  let { item, onclose, onedit }: { item: ArchiveItem; onclose: () => void; onedit: (item: ArchiveItem) => void } = $props();

  let video: HTMLVideoElement | undefined = $state();
  let playing = $state(false);
  let t = $state(0);
  let duration = $state(0);
  let failed = $state(false);
  let meta = $state<ArchiveMetadata | null>(null);
  let metaError = $state('');
  onMount(() => {
    getMetadata(item).then((m) => (meta = m), () => (metaError = 'The details could not be loaded.'));
  });
  // Closed: stop the download too (a <video> taken out of the page may keep fetching ranges).
  onDestroy(() => {
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  });
  const total = $derived(duration || item.durationS);
  function toggle() {
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }
  function step(d: number) {
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + d), total);
    t = video.currentTime;
  }
  function seek(e: Event) {
    if (!video) return;
    video.currentTime = Number((e.currentTarget as HTMLInputElement).value);
    t = video.currentTime;
  }
  const clock = (s: number) => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
  const kind = (k: string) => TRIGGER_LABELS[k as Trigger] ?? k;
  const pct = (s: number) => `${Math.round(s * 100)}%`;
  const sourceText = $derived.by(() => {
    const s = item.source;
    if (s.type === 'composition') return `Composed${s.anchor === 'at' ? ' around a second' : ''}: ${qualityText(String(s.size ?? item.quality))}, pre-roll ${s.preS ?? 0} s, post-roll ${s.postS ?? 0} s${s.badge ? ', still sections marked' : ''}`;
    if (s.type === 'recording') return `The camera’s ${s.stream === 'main' ? '4K' : 'SD'} recording, as it is`;
    if (s.type === 'clip') return 'The cam-proxy’s FTP copy, as it is';
    return '—';
  });
  function keys(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, button')) return;
    if (e.key === ' ') (e.preventDefault(), toggle());
    else if (e.key === 'ArrowLeft') step(e.shiftKey ? -10 : -1);
    else if (e.key === 'ArrowRight') step(e.shiftKey ? 10 : 1);
  }
</script>

<Modal title={item.name} testid="archive-player" {onclose} width={880}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="player" onkeydown={keys}>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={video}
      data-testid="archive-video"
      src={item.urls.video}
      preload="metadata"
      playsinline
      disableremoteplayback
      poster={item.urls.thumbnail ?? undefined}
      onplay={() => (playing = true)}
      onpause={() => (playing = false)}
      onended={() => (playing = false)}
      ontimeupdate={() => (t = video?.currentTime ?? 0)}
      onloadedmetadata={() => (duration = Number.isFinite(video?.duration) ? video!.duration : 0)}
      onerror={() => (failed = true)}
      onclick={toggle}
    ></video>
    {#if failed}<p class="err" role="alert" data-testid="archive-video-error">The video could not be loaded from the cam-proxy.</p>{/if}
    <div class="controls">
      <button data-testid="archive-back10" aria-label="Back 10 seconds" onclick={() => step(-10)}><Icon name="back10" /></button>
      <button data-testid="archive-back1" aria-label="Back 1 second" onclick={() => step(-1)}><Icon name="back1" /></button>
      <button class="play" data-testid="archive-play" aria-label={playing ? 'Pause' : 'Play'} onclick={toggle}><Icon name={playing ? 'pause' : 'play'} /></button>
      <button data-testid="archive-fwd1" aria-label="Forward 1 second" onclick={() => step(1)}><Icon name="fwd1" /></button>
      <button data-testid="archive-fwd10" aria-label="Forward 10 seconds" onclick={() => step(10)}><Icon name="fwd10" /></button>
      <input class="seek" type="range" data-testid="archive-seek" aria-label="Position" min="0" max={total} step="0.1" value={t} oninput={seek} />
      <span class="time" data-testid="archive-time">{clock(t)} / {clock(total)}</span>
    </div>
  </div>
  <div class="meta" data-testid="archive-meta">
    <dl>
      <dt>Recorded</dt><dd>{dateTime(item.recordedFrom)} – {formatClock(item.recordedTo)}</dd>
      <dt>Camera</dt><dd>{$cameraById(item.camera)?.name ?? item.cameraName}</dd>
      <dt>Duration</dt><dd>{durationText(item.durationS)}</dd>
      <dt>Quality</dt><dd>{qualityText(item.quality)}{item.original ? ' (original)' : ''}</dd>
      <dt>Size</dt><dd>{formatBytes(item.bytes)}</dd>
      <dt>Source</dt><dd data-testid="archive-source">{sourceText}</dd>
      <dt>Labels</dt><dd data-testid="archive-meta-labels">{item.labels.length ? item.labels.join(', ') : 'none'}</dd>
      <dt>Archived</dt><dd>{dateTime(item.createdAt)}</dd>
      <dt>Expires</dt><dd>{expiresText(item.expiresAt, Date.now())}{item.expiresAt ? ` (${dateTime(item.expiresAt).slice(0, 10)})` : ''}</dd>
    </dl>
    <div class="events">
      <h3>Events</h3>
      {#if meta}
        {#if meta.events.length}
          <ul data-testid="archive-events">
            {#each meta.events as e, i (i)}
              <li>
                <strong>{kind(e.kind)}</strong> {e.start ? formatClock(e.start) : ''}
                {#if e.analysis?.summary.length}<span class="vision">✦ Vision: {e.analysis.summary.map((s) => `${kind(s.category)} ${pct(s.score)}`).join(', ')}</span>
                {:else if e.analysis}<span class="vision">✦ Vision: nothing relevant</span>{/if}
                {#if e.analysis?.objects.length}<span class="objects">Objects: {e.analysis.objects.slice(0, 8).map((o) => `${o.name} ${pct(o.score)}`).join(', ')}</span>{/if}
              </li>
            {/each}
          </ul>
        {:else}<p class="muted">No events in this window.</p>{/if}
        {#if meta.stillChecks.length}
          <h3>Still checks</h3>
          <ul data-testid="archive-checks">
            {#each meta.stillChecks as c, i (i)}
              <li>{c.stillTs ? formatClock(c.stillTs) : ''} <span class="vision">✧ {c.summary.length ? c.summary.map((s) => `${kind(s.category)} ${pct(s.score)}`).join(', ') : 'nothing relevant'}</span></li>
            {/each}
          </ul>
        {/if}
      {:else if metaError}<p class="err">{metaError}</p>{:else}<p class="muted">Loading…</p>{/if}
    </div>
  </div>
  <footer>
    <a class="btn" data-testid="archive-download" href={item.urls.download} download><Icon name="download" /> Download</a>
    <button class="btn" data-testid="archive-player-edit" onclick={() => onedit(item)}><Icon name="edit" /> Edit</button>
  </footer>
</Modal>

<style>
  .player { display: grid; gap: 8px; }
  video { width: 100%; max-height: 60dvh; border-radius: 8px; background: var(--player-bg); }
  .controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .controls button { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  .controls .play { background: var(--grad); color: var(--on-grad); border: 0; }
  .seek { flex: 1; min-width: 120px; accent-color: var(--accent); }
  .time { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; font-size: 13px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  h3 { margin: 0 0 6px; font-size: 13px; color: var(--muted); font-weight: 600; }
  ul { margin: 0 0 10px; padding-left: 18px; display: grid; gap: 4px; }
  .vision { display: block; color: var(--text); }
  .objects { display: block; color: var(--muted); }
  .muted { margin: 0; color: var(--muted); }
  .err { margin: 0; color: var(--danger); font-size: 13px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
  .btn :global(svg) { width: 16px; height: 16px; }
  @media (max-width: 767px) {
    .meta { grid-template-columns: 1fr; }
  }
</style>
