<!-- web/src/components/Strip.svelte -->
<script lang="ts">
  import { stripSpans, windowAround, STRIP_ZOOMS, type Coverage } from '../lib/strip';
  import { zoom, pickZoom } from '../lib/zoomPref';
  import { previewAt, tileStyle, type PreviewMinute } from '../lib/timeline';
  import { addDays, localDate, type EventClip } from '../lib/recordings';
  import { filmFrames, FILM_H, FILM_W } from '../lib/film';

  // History's strip (spec 2026-09-27): the playhead stays in the centre and
  // time moves under it. Drag, sideways wheel, click and ←/→ move it.
  let {
    coverage, events, visibleIds, failedIds, at, now, currentId, previews, thumbFor, onseek, ondrag, onstep, oldest = null, pending = [], onglue, filmWidth,
  }: {
    coverage: Coverage;
    events: EventClip[];
    visibleIds: ReadonlySet<string>;
    failedIds: ReadonlySet<string>;
    at: number;
    now: number;
    currentId: string | null;
    previews: PreviewMinute[];
    thumbFor?: (clipId: string) => string;
    onseek: (at: number) => void;
    onglue?: () => void; // the Live panel: ⇥ goes back to live
    ondrag?: (active: boolean) => void;
    onstep?: (dir: -1 | 1) => void;
    oldest?: number | null; // the oldest content (the left edge); null: not known
    pending?: { kind: string; ts: number }[]; // live events not listed as recordings yet
    filmWidth?: number; // tests only: jsdom has no layout
  } = $props();

  const win = $derived(windowAround(at, $zoom));
  // The edges (Klaus, 2026-09-28): not before the oldest content, not after
  // now (2 s back, so a still shows) or the end of the latest known clip (a
  // camera clock ahead of the browser's).
  const lo = $derived(oldest ?? -Infinity);
  const hi = $derived(Math.max(now - 2000, ...events.map((e) => Date.parse(e.end))));
  const clampT = (t: number) => Math.min(hi, Math.max(lo, t));
  const seekTo = (t: number) => onseek(clampT(t));
  const span = $derived(win.end - win.start);
  const pct = (t: number) => ((t - win.start) / span) * 100;
  const spans = $derived(stripSpans(coverage, win, now, oldest));
  const segs = $derived(
    events
      .map((e) => ({ e, s: Date.parse(e.start), t: Date.parse(e.end) }))
      .filter(({ s, t }) => t > win.start && s < win.end)
      .map(({ e, s, t }) => ({ id: e.id, start: s, end: t, left: pct(Math.max(s, win.start)), width: Math.max(0.3, pct(Math.min(t, win.end)) - pct(Math.max(s, win.start))), ai: e.triggers.some((x) => x !== 'motion') })),
  );
  const nowLeft = $derived(now > win.start && now < win.end ? pct(now) : null);

  // Ticks counted from each local midnight (so they sit on local hours in any
  // time zone), labelled with the wall clock (the repeated hour on the 25-hour
  // day shows twice); a date at midnight.
  const ticks = $derived.by(() => {
    const h = $zoom >= 12 ? 3 : $zoom === 6 ? 1 : $zoom === 3 ? 0.5 : $zoom === 1 ? 0.25 : 5 / 60;
    const step = h * 3_600_000;
    const out: { left: number; label: string }[] = [];
    const times: number[] = [];
    for (let day = localDate(new Date(win.start)); ; day = addDays(day, 1)) {
      const [y, m, dd] = day.split('-').map(Number);
      const midnight = new Date(y, m - 1, dd).getTime();
      if (midnight > win.end) break;
      const next = new Date(y, m - 1, dd + 1).getTime();
      for (let t = midnight; t < next; t += step) if (t >= win.start && t <= win.end) times.push(t);
    }
    for (const t of times) {
      const d = new Date(t);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      const label = midnight
        ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`
        : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      out.push({ left: pct(t), label });
    }
    return out;
  });

  // Pointer: a press that moves less than 4 px is a click (seek there);
  // otherwise a drag (time follows the pointer, right = back in time).
  let press: { x: number; at: number; moved: boolean } | null = null;
  function timeAtX(e: PointerEvent | MouseEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return at + ((e.clientX - r.left - r.width / 2) / r.width) * span;
  }
  let dragging = $state(false);
  function down(e: PointerEvent) {
    press = { x: e.clientX, at, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function move(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (press) {
      const dx = e.clientX - press.x;
      if (!press.moved && Math.abs(dx) >= 4) {
        press.moved = true;
        dragging = true;
        hover = null;
        cursor = null;
        ondrag?.(true);
      }
      if (press.moved) seekTo(press.at - (dx / el.getBoundingClientRect().width) * span);
      return;
    }
    hoverAt(timeAtX(e, el), e, el);
  }
  function cancel() {
    if (press?.moved) ondrag?.(false);
    press = null;
    dragging = false;
  }
  function up(e: PointerEvent) {
    if (!press) return;
    const moved = press.moved;
    press = null;
    dragging = false;
    if (moved) return ondrag?.(false);
    // A click on a drawn event goes to its start: short clips are drawn wider
    // than they are (a minimum width), so the pixel may be past the clip.
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const p = ((e.clientX - r.left) / r.width) * 100;
    const tol = (3 / r.width) * 100; // 3 px either side: tiny segments are hard to hit
    const hit = segs.find((s) => p >= s.left - tol && p <= s.left + s.width + tol);
    const t = timeAtX(e, el);
    // Inside the clip's real span: that moment; on its drawn edge: its start.
    seekTo(hit && (t < hit.start || t >= hit.end) ? hit.start : t);
  }
  function wheel(e: WheelEvent) {
    const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
    if (!dx) return;
    e.preventDefault();
    seekTo(at + (dx / (e.currentTarget as HTMLElement).getBoundingClientRect().width) * span);
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      onstep?.(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  // Hover: the preview frame of that second, or the event's thumbnail (after
  // a 150 ms rest, as before).
  const REST_MS = 150;
  let hover = $state<{ left: number; label: string; style: string | null; img?: string } | null>(null);
  let rest: ReturnType<typeof setTimeout> | undefined;
  // A line and the time under the pointer, precise where a hand wasn't
  // (Klaus, 2026-09-28); the picture above it only where there is one.
  let cursor = $state<{ left: number; label: string } | null>(null);
  function hoverAt(t: number, e: PointerEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const left = ((e.clientX - r.left) / r.width) * 100;
    const label = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    cursor = { left, label };
    const p = previewAt(previews, t);
    const ev = !p && thumbFor ? events.find((x) => t >= Date.parse(x.start) && t < Date.parse(x.end)) : undefined;
    if (!p && !ev) return hidePicture();
    const style = p ? tileStyle(p.minute, p.index, 1) : null;
    const img = ev && thumbFor ? thumbFor(ev.id) : undefined;
    const same = hover && (hover.style === style || (img && hover.img === img));
    hover = { left, label, style: same ? hover!.style : null, img: same ? hover!.img : undefined };
    if (same) return;
    clearTimeout(rest);
    rest = setTimeout(() => {
      if (hover) hover = { ...hover, style, img };
    }, REST_MS);
  }
  function hidePicture() {
    clearTimeout(rest);
    hover = null;
  }
  function leave() {
    hidePicture();
    cursor = null;
  }

  // The band of small frames under the bar (Klaus, 2026-09-28).
  let measured = $state(0);
  const film = $derived(filmFrames(win, filmWidth ?? measured, previews));
</script>

<div class="wrap">
  {#if hover}
    <div class="scrub" style={`left: clamp(84px, ${hover.left}%, calc(100% - 84px))`} data-testid="scrub-preview" aria-hidden="true">
      {#if hover.img}<img class="frame" src={hover.img} alt="" width="160" height="90" onerror={() => hover && (hover = { ...hover, img: undefined })} />
      {:else}<span class="frame" style={hover.style ?? 'width: 160px; height: 90px'}></span>{/if}
      <span class="when" data-testid="strip-cursor-time">{hover.label}</span>
    </div>
  {/if}
  <div class="tools">
    <div class="zoom" role="group" aria-label="Timeline zoom">
      {#each STRIP_ZOOMS as z (z)}
        <button data-testid={`zoom-${z}`} aria-pressed={$zoom === z} onclick={() => void pickZoom(z)}>{z >= 1 ? `${z} h` : `${z * 60} min`}</button>
      {/each}
    </div>
  </div>
  <div class="row">
  <div class="edge">
    <button data-testid="strip-oldest" title="The oldest recording" aria-label="Go to the oldest recording" disabled={oldest === null || at <= lo} onclick={() => seekTo(lo)}>⇤</button>
    <button data-testid="strip-back" title={`Back ${$zoom} h`} aria-label={`Back ${$zoom} hours`} disabled={at <= lo} onclick={() => seekTo(at - span)}>‹</button>
  </div>
  <div class="barwrap">
  <!-- The playhead's mark above the bar (Klaus, 2026-09-28: more prominent). -->
  <span class="mark" data-testid="strip-playhead-mark" aria-hidden="true"></span>
  <div class="bar" class:dragging data-testid="timeline" role="slider" tabindex="0" aria-label="Recordings timeline" aria-valuenow={Math.round(at / 1000)}
    onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel} onlostpointercapture={cancel} onpointerleave={leave} onwheel={wheel} onkeydown={keydown}>
    {#each spans as s, i (i)}
      <span class={`span ${s.kind}`} data-testid="strip-span" data-kind={s.kind} style={`left:${s.left}%;width:${s.width}%`}></span>
    {/each}
    {#each segs as s (s.id)}
      <span class="seg" class:ai={s.ai} class:on={s.id === currentId} class:dim={!visibleIds.has(s.id)} class:failed={failedIds.has(s.id)}
        data-testid="timeline-seg" data-clip-id={s.id} style={`left:${s.left}%;width:${s.width}%`}></span>
    {/each}
    {#each pending.filter((p) => p.ts > win.start && p.ts < win.end) as p (p.ts)}
      <span class="pending" data-testid="strip-pending" title={`${p.kind}, recording…`} style={`left:${pct(p.ts)}%`}></span>
    {/each}
    {#if nowLeft !== null}<span class="now" data-testid="timeline-now" style={`left:${nowLeft}%`}></span>{/if}
    <span class="playhead" data-testid="strip-playhead" style="left:50%"></span>
    {#if cursor}
      <span class="cursor" data-testid="strip-cursor" style={`left:${cursor.left}%`}></span>
      {#if !hover}<span class="cursor-time" class:flip={cursor.left > 80} data-testid="strip-cursor-time" style={`left:${cursor.left}%`}>{cursor.label}</span>{/if}
    {/if}
    <div class="ticks">
      {#each ticks as t (t.left)}<span data-testid="strip-tick" style={`left:${t.left}%`}>{t.label}</span>{/each}
    </div>
  </div>
  </div>
  <div class="edge">
    <button data-testid="strip-forward" title={`Forward ${$zoom} h`} aria-label={`Forward ${$zoom} hours`} disabled={at >= hi} onclick={() => seekTo(at + span)}>›</button>
    <button data-testid="strip-now" title="Now" aria-label="Go to now" disabled={!onglue && at >= now - 5000} onclick={() => (onglue ? onglue() : onseek(Math.max(lo, now - 2000)))}>⇥</button>
  </div>
  </div>
  <!-- Aligned with the bar: the edge buttons' width either side. -->
  <div class="film-row">
    <div class="film" data-testid="strip-film" bind:clientWidth={measured} style={`height:${FILM_H}px`}>
      {#each film as f (f.t)}
        <button class="frame-btn" data-testid="strip-film-frame" data-t={f.t} tabindex="-1" aria-label={new Date(f.t).toLocaleTimeString()}
          style={`left:calc(${f.left}% - ${FILM_W / 2}px);width:${FILM_W}px;height:${FILM_H}px`} onclick={() => seekTo(f.t)}>
          {#if f.tile}<span class="tile" style={tileStyle(f.tile.minute, f.tile.index, (FILM_W - 2) / f.tile.minute.tileW)}></span>{/if}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 6px; position: relative; }
  .row { display: flex; align-items: stretch; gap: 6px; }
  .barwrap { position: relative; flex: 1; min-width: 0; }
  .mark { position: absolute; left: 50%; top: -8px; transform: translateX(-50%); width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 7px solid var(--accent); z-index: 2; pointer-events: none; }
  .edge { display: flex; gap: 4px; }
  .edge button { width: 30px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; font-size: 15px; line-height: 1; padding: 0; }
  .edge button:disabled { opacity: 0.35; cursor: default; }
  .scrub { position: absolute; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 5; pointer-events: none; display: grid; gap: 2px; padding: 4px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); }
  .frame { display: block; border-radius: 4px; background-color: var(--surface-2); }
  img.frame { width: 160px; height: 90px; object-fit: cover; }
  .when { font-size: 11px; color: var(--muted); text-align: center; font-family: var(--mono); }
  .tools { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .zoom { display: flex; gap: 4px; }
  .zoom button { font-size: 12px; padding: 3px 9px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .zoom button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); border-color: var(--accent); }
  .bar { position: relative; height: 46px; border-radius: 10px; background: var(--strip-empty); border: 1px solid var(--border); cursor: crosshair; overflow: hidden; touch-action: pan-y; user-select: none; }
  .bar.dragging { cursor: grabbing; }
  .cursor { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--text); opacity: 0.7; pointer-events: none; }
  .cursor-time { position: absolute; top: 2px; margin-left: 4px; font-size: 10px; font-family: var(--mono); color: var(--text); background: color-mix(in srgb, var(--surface) 80%, transparent); padding: 0 3px; border-radius: 3px; pointer-events: none; white-space: nowrap; }
  .cursor-time.flip { transform: translateX(calc(-100% - 8px)); }
  .film-row { padding: 0 70px; } /* two 30 px edge buttons, their 4 px gap and the row's 6 px gap, each side */
  .film { position: relative; overflow: hidden; }
  .frame-btn { position: absolute; top: 0; padding: 0; border: 1px solid var(--border); box-sizing: border-box; border-radius: 4px; overflow: hidden; background: var(--no-thumb-bg); cursor: pointer; }
  .frame-btn:hover { border-color: var(--accent); }
  .frame-btn .tile { display: block; }
  .span { position: absolute; top: 0; bottom: 0; pointer-events: none; }
  .span.pictures { background: var(--strip-stills); }
  .span.none { background: var(--strip-empty); }
  .span.outside { background: var(--strip-outside-bg); }
  .seg { position: absolute; top: 8px; height: 18px; border-radius: 4px; background: color-mix(in srgb, var(--accent-2) 60%, transparent); pointer-events: none; }
  .seg.ai { background: var(--accent); }
  .seg.on { outline: 2px solid var(--text); outline-offset: 1px; }
  .seg.dim { opacity: 0.3; }
  .seg.failed { background: var(--no-thumb-bg); }
  .pending { position: absolute; top: 8px; height: 18px; width: 4px; margin-left: -2px; border-radius: 2px; background: var(--danger); pointer-events: none; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .now { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text); opacity: 0.5; pointer-events: none; }
  .playhead { position: absolute; top: -2px; bottom: -2px; width: 3px; margin-left: -1.5px; background: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bg) 60%, transparent); pointer-events: none; }
  .ticks { position: absolute; left: 0; right: 0; bottom: 2px; height: 12px; pointer-events: none; }
  .ticks span { position: absolute; transform: translateX(-50%); font-size: 10px; color: var(--muted); font-family: var(--mono); white-space: nowrap; }
</style>
