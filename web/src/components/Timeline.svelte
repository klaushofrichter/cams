<script module lang="ts">
  // ‹ › past the day's edge: the next day's timeline opens on the window next
  // to the one just left (the last hour of the previous day, or the first).
  let carry: { from: string; dir: -1 | 1 } | null = null;
</script>

<script lang="ts">
  import { dayLength, dayStartMs as dayStart, formatClock, layoutSegments, legendTicks, localDate, panWindow, secondsIntoDay, tickLabel, timelineWindow, type EventClip, type Zoom } from '../lib/recordings';
  import { preferences, savePreferences } from '../lib/preferences';
  import { timeZoneLabel } from '../lib/clock';
  import { previewAt, thumbCoverage, tileStyle, type PreviewMinute } from '../lib/timeline';

  let {
    events,
    date,
    selectedId,
    onpick,
    onstep,
    onedge,
    compact = false,
    testid = 'timeline',
    legend = false,
    now = null,
    updatedAt = null,
    previews = [],
    dayStartMs = null,
    onday,
    thumbFor,
  }: {
    events: EventClip[];
    date: string;
    selectedId: string | null;
    onpick: (sec: number) => void;
    onstep: (dir: -1 | 1) => void;
    onedge: (edge: 'start' | 'end') => void;
    compact?: boolean;
    testid?: string;
    legend?: boolean;
    now?: number | null;
    updatedAt?: Date | null;
    // Plan 7: the day's preview sprites from the camera's cam-proxy; moving
    // over the bar shows the frame of that moment.
    previews?: PreviewMinute[];
    dayStartMs?: number | null;
    // Moving a zoomed window past the day's first or last hour.
    onday?: (dir: -1 | 1) => void;
    // An event's thumbnail, shown on hover where there is no preview sprite.
    thumbFor?: (clipId: string) => string;
  } = $props();

  // The box and time follow the pointer at once; the frame (a sprite
  // download per minute) only once the pointer rests in a minute for 150 ms,
  // so a sweep across the day doesn't fetch every sprite on the way.
  const REST_MS = 150;
  let hover = $state<{ left: number; label: string; minute: number; style: string | null; img?: string } | null>(null);
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingStyle = '';
  function move(e: PointerEvent) {
    if (compact || (!previews.length && !thumbFor)) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const sec = win.start + frac * (win.end - win.start);
    const ts = (dayStartMs ?? dayStart(date)) + sec * 1000;
    const label = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = previews.length ? previewAt(previews, ts) : null;
    if (!p) {
      // No sprite here: the event's own thumbnail, if the pointer is on one.
      const at = thumbFor && events.find((x) => { const s = secondsIntoDay(x.start, date); return sec >= s && sec <= s + x.durationSec; });
      if (!at) return leave();
      clearTimeout(restTimer);
      hover = { left: frac * 100, label, minute: -1, style: null, img: thumbFor!(at.id) };
      return;
    }
    const style = tileStyle(p.minute, p.index, 1);
    if (hover && hover.minute === p.minute.minute && hover.style !== null) {
      hover = { left: frac * 100, label, minute: p.minute.minute, style }; // same sprite: already loaded
      return;
    }
    const sameWait = hover !== null && hover.minute === p.minute.minute; // already waiting for this sprite
    hover = { left: frac * 100, label, minute: p.minute.minute, style: null };
    pendingStyle = style;
    if (sameWait) return;
    clearTimeout(restTimer);
    restTimer = setTimeout(() => {
      if (hover && hover.minute === p.minute.minute) hover = { ...hover, style: pendingStyle };
    }, REST_MS);
  }
  function leave() {
    clearTimeout(restTimer);
    hover = null;
  }

  // The zoom is the saved preference (it may load after this timeline), and
  // picking one saves it, so it stays when switching pages (Klaus, 2026-09-27).
  let chosen = $state<Zoom | null>(null);
  const zoom: Zoom = $derived(chosen ?? $preferences?.timelineZoom ?? 24);
  function pickZoom(z: Zoom) {
    chosen = z;
    preferences.update((p) => (p ? { ...p, timelineZoom: z } : p));
    void savePreferences({ timelineZoom: z }).catch(() => undefined);
  }
  const daySec = $derived(dayLength(date));
  const selected = $derived(events.find((e) => e.id === selectedId) ?? null);
  const center = $derived(selected ? secondsIntoDay(selected.start, date) : daySec / 2);
  // A zoomed window follows the selected clip until moved with ‹ ›; a new
  // selection, zoom or day centres it again.
  let panStart = $state<number | null>(null);
  $effect(() => {
    void selectedId;
    void zoom;
    void date;
    panStart = null;
    if (carry && carry.from !== date) {
      const span = base.end - base.start;
      panStart = carry.dir < 0 ? daySec - span : 0;
      carry = null;
    }
  });
  const base = $derived(timelineWindow(compact ? 24 : zoom, center, daySec));
  const win = $derived(panStart === null ? base : { start: panStart, end: panStart + (base.end - base.start) });
  function pan(dir: -1 | 1) {
    const next = panWindow(win, dir, daySec);
    if (typeof next === 'string') {
      if (!onday) return;
      carry = { from: date, dir };
      onday(dir);
    }
    else panStart = next.start;
  }
  const rangeLabel = $derived(`${tickLabel(date, win.start)}–${win.end >= daySec ? '24:00' : tickLabel(date, win.end)}`);
  const cover = $derived(
    compact ? [] : thumbCoverage(previews, events.map((x) => { const s = secondsIntoDay(x.start, date); return { start: s, end: s + x.durationSec }; }), dayStartMs ?? dayStart(date), win),
  );
  const segs = $derived(layoutSegments(events, date, win));
  const ticks = $derived.by(() => {
    const step = win.end - win.start > 6 * 3600 ? 3 * 3600 : win.end - win.start > 3600 ? 3600 : 600;
    const out: { left: number; label: string }[] = [];
    for (let s = Math.ceil(win.start / step) * step; s <= win.end; s += step) {
      out.push({ left: ((s - win.start) / (win.end - win.start)) * 100, label: tickLabel(date, s) });
    }
    return out;
  });

  // Legend mode (the Live mini timeline): fixed ticks every 6 hours plus the
  // day's end ("24:00"), labelled so they follow the clock across DST.
  const legendTickMarks = $derived(legendTicks(date, daySec).map((t) => ({ left: (t.sec / daySec) * 100, label: t.label })));

  const isToday = $derived(date === localDate(new Date()));
  const captionText = $derived(`${isToday ? 'Today' : date}, 00:00–24:00, times in ${timeZoneLabel(new Date())}`);
  const nowLeft = $derived(now !== null && now >= win.start && now <= win.end ? ((now - win.start) / (win.end - win.start)) * 100 : null);

  function click(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onpick(win.start + frac * (win.end - win.start));
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onstep(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onstep(1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onedge('start');
    } else if (e.key === 'End') {
      e.preventDefault();
      onedge('end');
    }
  }
</script>

<div class="wrap" class:compact class:legend>
  {#if hover}
    <div class="scrub" style={`left: clamp(84px, ${hover.left}%, calc(100% - 84px))`} data-testid="scrub-preview" aria-hidden="true">
      {#if hover.img}
        <img class="frame" src={hover.img} alt="" width="160" height="90" />
      {:else}
        <span class="frame" style={hover.style ?? 'width: 160px; height: 90px'}></span>
      {/if}
      <span class="when">{hover.label}</span>
    </div>
  {/if}
  {#if !compact}
    <div class="tools">
      {#if zoom !== 24}
        <div class="pan" role="group" aria-label="Move the timeline">
          <button data-testid="timeline-prev" aria-label="Earlier" onclick={() => pan(-1)}>‹</button>
          <span class="range" data-testid="timeline-range">{rangeLabel}</span>
          <button data-testid="timeline-next" aria-label="Later" onclick={() => pan(1)}>›</button>
        </div>
      {/if}
      <div class="zoom" role="group" aria-label="Timeline zoom">
        {#each [24, 6, 1] as z (z)}
          <button data-testid={`zoom-${z}`} aria-pressed={zoom === z} onclick={() => pickZoom(z as Zoom)}>{z} h</button>
        {/each}
      </div>
    </div>
  {/if}
  <div class="bar" data-testid={testid} role="slider" tabindex="0" aria-label="Recordings timeline" aria-valuemin={0} aria-valuemax={daySec} aria-valuenow={Math.round(center)} onclick={click} onkeydown={keydown} onpointermove={move} onpointerleave={leave}>
    {#each cover as c (c.left)}
      <span class="thumb-span" data-testid="timeline-thumb-span" style={`left:${c.left}%;width:${c.width}%`}></span>
    {/each}
    {#each segs as s (s.id)}
      <span class="seg" class:ai={s.ai} class:on={s.id === selectedId} data-testid="timeline-seg" data-clip-id={s.id} style={`left:${s.left}%;width:${s.width}%`}></span>
    {/each}
    {#if nowLeft !== null}
      <span class="now" role="img" data-testid="timeline-now" style={`left:${nowLeft}%`} aria-label="Now"></span>
    {/if}
    {#if !legend}
      <div class="ticks">
        {#each ticks as t (t.left)}<span style={`left:${t.left}%`}>{t.label}</span>{/each}
      </div>
    {/if}
  </div>
  {#if legend}
    <div class="ticks legend-ticks">
      {#each legendTickMarks as t (t.left)}<span style={`left:${t.left}%`}>{t.label}</span>{/each}
    </div>
    <p class="caption" data-testid="live-timeline-legend">
      {captionText}{#if updatedAt}, <span data-testid="live-timeline-updated">updated {formatClock(updatedAt.toISOString())}</span>{/if}
    </p>
  {/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 6px; position: relative; }
  .scrub { position: absolute; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 5; pointer-events: none; display: grid; gap: 2px; padding: 4px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); }
  .frame { display: block; border-radius: 4px; background-color: var(--surface-2); }
  .when { font-size: 11px; color: var(--muted); text-align: center; font-family: var(--mono); }
  .tools { display: flex; gap: 12px; justify-content: flex-end; align-items: center; }
  .zoom, .pan { display: flex; gap: 4px; align-items: center; }
  .pan button { font-size: 14px; line-height: 1; padding: 3px 9px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
  .range { font-size: 12px; color: var(--muted); font-family: var(--mono); min-width: 92px; text-align: center; }
  img.frame { width: 160px; height: 90px; object-fit: cover; }
  .zoom button { font-size: 12px; padding: 3px 9px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .zoom button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); border-color: var(--accent); }
  .bar { position: relative; height: 46px; border-radius: 10px; background: var(--no-thumb-bg); border: 1px solid var(--border); cursor: pointer; overflow: hidden; }
  .compact .bar { background: var(--surface-2); }
  .thumb-span { position: absolute; top: 0; bottom: 0; background: var(--surface-2); pointer-events: none; }
  .compact .bar { height: 30px; }
  .seg { position: absolute; top: 8px; height: 18px; border-radius: 4px; background: color-mix(in srgb, var(--accent-2) 60%, transparent); transition: transform 0.15s ease; }
  .compact .seg { top: 6px; height: 12px; }
  .seg.ai { background: var(--accent); }
  .seg.on { outline: 2px solid var(--text); outline-offset: 1px; }
  .now { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text); opacity: 0.6; pointer-events: none; }
  .ticks { position: absolute; left: 0; right: 0; bottom: 2px; height: 12px; pointer-events: none; }
  .ticks span { position: absolute; transform: translateX(-50%); font-size: 10px; color: var(--muted); font-family: var(--mono); }
  .compact .ticks { display: none; }
  .legend-ticks { position: relative; height: 16px; pointer-events: none; }
  .legend-ticks span { position: absolute; transform: translateX(-50%); font-size: 10px; color: var(--muted); font-family: var(--mono); }
  .caption { margin: 0; font-size: 11px; color: var(--muted); }
</style>
