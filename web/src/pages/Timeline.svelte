<script lang="ts">
  import { navigate } from '../lib/router';
  import { onMount } from 'svelte';
  import { getJson } from '../lib/api';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { eventStream } from '../lib/eventStream';
  import { localDate } from '../lib/recordings';
  import { todayDate } from '../lib/refresh';
  import { cursorSearch, dayRange, hourGroups, minuteOf, splitRange, stillIndex, tileStyle, timelineCursor, type PreviewMinute } from '../lib/timeline';

  // A day of the camera's cam-proxy stills (Plan 6): one tile per minute from
  // the preview sprites, event minutes marked, a click shows the still. The
  // URL holds the view (?cam&date&t).
  interface Ev { start: string; end: string; triggers: string[] }

  const initial = timelineCursor(new URLSearchParams(location.search), localDate(new Date()));
  let date = $state(initial.date);
  let wantT: number | null = initial.t; // a still to open once its day is loaded
  let minutes = $state<PreviewMinute[]>([]);
  let events = $state<Ev[]>([]);
  let message = $state('');
  let open = $state<{ minute: PreviewMinute; stills: number[]; i: number } | null>(null);
  let refreshTick = $state(0);
  let showSeq = 0;

  onMount(() => {
    if (initial.cam && $cameras.some((c) => c.id === initial.cam)) selectedCameraId.set(initial.cam);
  });

  const camera = $derived($cameras.find((c) => c.id === $selectedCameraId) ?? null);
  const base = $derived(camera ? `/api/cameras/${encodeURIComponent(camera.id)}` : '');
  const hours = $derived(hourGroups(minutes));
  const eventIn = (m: PreviewMinute) =>
    events.find((e) => Date.parse(e.start) < m.minute + 60_000 && Date.parse(e.end) >= m.minute) ?? null;
  const firstTile = (m: PreviewMinute) => Math.max(0, m.present.indexOf(true));
  const clock = (ts: number, seconds = false) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });

  // The day's previews (in parts: the fall-back day is 25 h) and events.
  async function fetchDay(b: string, d: string): Promise<{ m: PreviewMinute[]; ev: Ev[] }> {
    const [from, to] = dayRange(d);
    const [parts, ev] = await Promise.all([
      Promise.all(splitRange(from, to).map(([a, z]) => getJson<PreviewMinute[]>(`${b}/previews?from=${a}&to=${z}`))),
      getJson<{ events: Ev[] }>(`${b}/events?date=${d}`).catch(() => ({ events: [] as Ev[] })),
    ]);
    return { m: parts.flat(), ev: ev.events };
  }

  // A camera or day change: clear, then load.
  $effect(() => {
    const cam = camera;
    const d = date;
    minutes = [];
    events = [];
    open = null;
    message = '';
    if (!cam?.proxy || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    message = 'Loading…';
    let stale = false;
    const b = base;
    fetchDay(b, d).then(
      ({ m, ev }) => {
        if (stale) return;
        minutes = m;
        events = ev;
        message = m.length ? '' : 'No stills for this day.';
        const t = wantT;
        wantT = null;
        const target = t === null ? undefined : m.find((x) => x.minute === minuteOf(t));
        if (target && t !== null) void show(target, t, 1);
      },
      () => {
        if (!stale) message = 'The camera gateway is not reachable right now.';
      },
    );
    return () => (stale = true);
  });

  // A live change on today: refresh in place (the open still stays).
  $effect(() => {
    if (!refreshTick) return;
    const cam = camera;
    const d = date;
    if (!cam?.proxy) return;
    let stale = false;
    fetchDay(base, d).then(
      ({ m, ev }) => {
        if (stale) return;
        minutes = m;
        events = ev;
        if (m.length) message = '';
        if (open) {
          const same = m.find((x) => x.minute === open!.minute.minute);
          if (same) open = { ...open, minute: same };
        }
      },
      () => undefined,
    );
    return () => (stale = true);
  });

  $effect(() => {
    void $cameras;
    const stop = eventStream()?.watch(() => camera?.id ?? '', () => { if (date === $todayDate) refreshTick++; }, 5000);
    return () => stop?.();
  });

  // The URL follows the view.
  $effect(() => {
    const search = cursorSearch({ cam: camera?.id ?? null, date, t: open ? open.stills[open.i] : null });
    if (search !== location.search) history.replaceState(history.state, '', `${location.pathname}${search}`);
  });

  async function show(m: PreviewMinute, target?: number, dir: 1 | -1 = 1) {
    const seq = ++showSeq;
    try {
      const stills = await getJson<number[]>(`${base}/stills?from=${m.minute}&to=${m.minute + 59_999}`);
      if (seq !== showSeq || !stills.length) return;
      const at = target ?? m.minute + firstTile(m) * m.intervalS * 1000;
      open = { minute: m, stills, i: stillIndex(stills, at, dir) };
    } catch {
      if (seq === showSeq) message = 'Could not load that minute.';
    }
  }
  function step(dir: -1 | 1) {
    if (!open) return;
    const i = open.i + dir;
    if (i >= 0 && i < open.stills.length) return void (open = { ...open, i });
    // Into the neighbouring minute: its first still going forward, its last going back.
    const k = minutes.findIndex((x) => x.minute === open!.minute.minute) + dir;
    if (k >= 0 && k < minutes.length) void show(minutes[k], dir > 0 ? minutes[k].minute : minutes[k].minute + 59_999, dir);
  }
  function onkey(e: KeyboardEvent) {
    if (!open || (e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Escape') open = null;
    else return;
    e.preventDefault();
  }

  // Sprites load when their tile scrolls into view (a day is up to 1440).
  function lazyStyle(node: HTMLElement, style: string) {
    let current = style;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) {
        node.setAttribute('style', current);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(node);
    return {
      update(s: string) {
        current = s;
        if (node.getAttribute('style')) node.setAttribute('style', s);
      },
      destroy: () => io.disconnect(),
    };
  }
</script>

<svelte:window onkeydown={onkey} />

<section class="timeline" data-testid="timeline-page">
  <header>
    <h1>Timeline</h1>
    <input type="date" bind:value={date} max={$todayDate} data-testid="timeline-day" aria-label="Day" />
  </header>

  {#if !camera}
    <p class="muted">No camera selected.</p>
  {:else if !camera.proxy}
    <p class="muted" data-testid="timeline-no-proxy">{camera.name} has no camera gateway (cam-proxy), so there are no stills to show.</p>
  {:else}
    {#if open}
      {@const ts = open.stills[open.i]}
      <div class="viewer" data-testid="timeline-viewer">
        <img src={`${base}/stills/${ts}.jpg`} alt={`${camera.name} at ${clock(ts, true)}`} data-testid="timeline-still" />
        <div class="bar">
          <button onclick={() => step(-1)} aria-label="Previous second">◀</button>
          <span class="mono">{clock(ts, true)}</span>
          <button onclick={() => step(1)} aria-label="Next second">▶</button>
          <a data-testid="timeline-open-history" href={`/app/recordings?cam=${encodeURIComponent(camera.id)}&panel=history&at=${ts}`}
            onclick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate((e.currentTarget as HTMLAnchorElement).getAttribute('href')!); } }}>Open in History</a>
          <button onclick={() => (open = null)} data-testid="timeline-close">Close</button>
        </div>
      </div>
    {/if}
    {#if message}<p class="muted" data-testid="timeline-message">{message}</p>{/if}
    {#each hours as h (h.hour)}
      <div class="hour">
        <div class="label mono">{String(h.hour).padStart(2, '0')}:00</div>
        <div class="tiles">
          {#each h.minutes as m (m.minute)}
            {@const ev = eventIn(m)}
            <button class="tile" class:event={!!ev} class:active={open?.minute.minute === m.minute} title={clock(m.minute) + (ev ? ` · ${ev.triggers.join(', ')}` : '')}
              aria-label={`${clock(m.minute)}${ev ? `, event: ${ev.triggers.join(', ')}` : ''}`}
              onclick={() => void show(m)} data-testid="timeline-minute">
              <span class="img" use:lazyStyle={tileStyle(m, firstTile(m), 0.5)}></span>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</section>

<style>
  .timeline { display: grid; gap: 12px; }
  header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; }
  input { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; }
  .muted { color: var(--muted); margin: 0; }
  .mono { font-family: var(--mono); }
  .viewer { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; display: grid; gap: 8px; }
  .viewer img { width: 100%; max-height: 60vh; object-fit: contain; background: var(--bg); border-radius: 8px; }
  .bar { display: flex; gap: 8px; align-items: center; }
  .bar button { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
  .hour { display: grid; grid-template-columns: 52px 1fr; gap: 8px; align-items: start; }
  .label { color: var(--muted); font-size: 12px; padding-top: 4px; }
  .tiles { display: flex; flex-wrap: wrap; gap: 3px; }
  .tile { padding: 0; border: 2px solid transparent; border-radius: 4px; background: var(--surface-2); cursor: pointer; line-height: 0; }
  .tile.event { border-color: var(--accent); }
  .tile.active { border-color: var(--accent-2); }
  .img { display: block; width: 80px; height: 45px; }
  @media (max-width: 600px) {
    .hour { grid-template-columns: 1fr; }
  }
</style>
