<script lang="ts">
  import { dayLength, formatClock, layoutSegments, legendTicks, localDate, secondsIntoDay, tickLabel, type EventClip } from '../lib/recordings';
  import { timeZoneLabel } from '../lib/clock';

  // A whole day's recordings as one bar (Live's mini timeline). History uses
  // the continuous strip (Strip.svelte) instead.
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
  } = $props();

  const daySec = $derived(dayLength(date));
  const win = $derived({ start: 0, end: daySec });
  const selected = $derived(events.find((e) => e.id === selectedId) ?? null);
  const center = $derived(selected ? secondsIntoDay(selected.start, date) : daySec / 2);
  const segs = $derived(layoutSegments(events, date, win));
  const ticks = $derived.by(() => {
    const step = 3 * 3600;
    const out: { left: number; label: string }[] = [];
    for (let s = 0; s <= daySec; s += step) out.push({ left: (s / daySec) * 100, label: tickLabel(date, s) });
    return out;
  });

  // Legend mode: fixed ticks every 6 hours plus the day's end ("24:00"),
  // labelled so they follow the clock across DST.
  const legendTickMarks = $derived(legendTicks(date, daySec).map((t) => ({ left: (t.sec / daySec) * 100, label: t.label })));

  const isToday = $derived(date === localDate(new Date()));
  const captionText = $derived(`${isToday ? 'Today' : date}, 00:00–24:00, times in ${timeZoneLabel(new Date())}`);
  const nowLeft = $derived(now !== null && now >= 0 && now <= daySec ? (now / daySec) * 100 : null);

  function click(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onpick(frac * daySec);
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
  <div class="bar" data-testid={testid} role="slider" tabindex="0" aria-label="Recordings timeline" aria-valuemin={0} aria-valuemax={daySec} aria-valuenow={Math.round(center)} onclick={click} onkeydown={keydown}>
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
  .bar { position: relative; height: 46px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); cursor: pointer; overflow: hidden; }
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
