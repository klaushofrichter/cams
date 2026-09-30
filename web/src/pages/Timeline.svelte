<script lang="ts">
  import { navigate } from '../lib/router';
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { getJson } from '../lib/api';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { eventStream } from '../lib/eventStream';
  import { liveEventsOn } from '../lib/preferences';
  import { addDays, formatClock, localDate, saveCursor, TRIGGER_LABELS, type Trigger } from '../lib/recordings';
  import { todayDate } from '../lib/refresh';
  import type { StillObject } from '../lib/vision';
  import TimelineStill from '../components/TimelineStill.svelte';
  import {
    analysedSeconds, cardKind, cardsInMinute, cursorSearch, dayRange, hourGroups, loadViewPoint, minuteMarks, nearestMinute, saveViewPoint,
    secondKinds, splitRange, stepMinute, stillIndex, tileStyle, timelineCursor, type PreviewMinute, type SeenStill, type TimelineCard,
  } from '../lib/timeline';

  // A day of the camera's cam-proxy stills (Plan 6) on cam-proxy's model (spec
  // 2026-09-30-analytics-in-cams-design): one tile per minute; a minute opens
  // its seconds under its hour; a second opens the large still, with Vision's
  // boxes where it was analysed. The URL holds the view (?cam&date&t).

  const initial = timelineCursor(new URLSearchParams(location.search), localDate(new Date()));
  // Opened without a position of its own (the menu): the view point shared
  // with History and Live (Klaus, 2026-09-29): History's time, or now.
  const shared = initial.t === null && !new URLSearchParams(location.search).has('date')
    ? loadViewPoint(initial.cam ?? get(selectedCameraId) ?? '')
    : undefined;
  const sharedAt = shared ? (shared.at ?? Date.now()) : null;
  let date = $state(sharedAt !== null ? localDate(new Date(sharedAt)) : initial.date);
  let wantT: number | null = sharedAt ?? initial.t; // a time to open once its day is loaded
  let minutes = $state<PreviewMinute[]>([]);
  let cards = $state<TimelineCard[]>([]);
  let message = $state('');
  let open = $state<PreviewMinute | null>(null); // the minute view
  let still = $state<{ ts: number; seen: SeenStill | null } | null>(null); // the large still
  let refreshTick = $state(0);
  let pickSeq = 0;

  onMount(() => {
    if (initial.cam && $cameras.some((c) => c.id === initial.cam)) selectedCameraId.set(initial.cam);
  });

  const camera = $derived($cameras.find((c) => c.id === $selectedCameraId) ?? null);
  const base = $derived(camera ? `/api/cameras/${encodeURIComponent(camera.id)}` : '');
  const hours = $derived(hourGroups(minutes));
  const firstTile = (m: PreviewMinute) => Math.max(0, m.present.indexOf(true));
  const clock = (ts: number, seconds = false) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  const labels = (c: TimelineCard) => c.triggers.map((t) => TRIGGER_LABELS[t as Trigger] ?? t).join(', ') || 'Recording';

  // The day's previews (in parts: the fall-back day is 25 h) and cards.
  async function fetchDay(b: string, d: string): Promise<{ m: PreviewMinute[]; ev: TimelineCard[] }> {
    const [from, to] = dayRange(d);
    const [parts, ev] = await Promise.all([
      Promise.all(splitRange(from, to).map(([a, z]) => getJson<PreviewMinute[]>(`${b}/previews?from=${a}&to=${z}`))),
      // The camera's day and its neighbours: with the browser in another
      // zone, the tiles' day spans two camera days (issue #38).
      Promise.all([addDays(d, -1), d, addDays(d, 1)].map((x) => getJson<{ events: TimelineCard[] }>(`${b}/events?date=${x}`).catch(() => ({ events: [] as TimelineCard[] })))),
    ]);
    return { m: parts.flat(), ev: ev.flatMap((x) => x.events) };
  }

  // A camera or day change: clear, then load.
  $effect(() => {
    const cam = camera;
    const d = date;
    minutes = [];
    cards = [];
    open = null;
    still = null;
    ++pickSeq; // a still still loading for the day before is dropped
    message = '';
    if (!cam?.proxy || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    message = 'Loading…';
    let stale = false;
    const b = base;
    fetchDay(b, d).then(
      ({ m, ev }) => {
        if (stale) return;
        minutes = m;
        cards = ev;
        message = m.length ? '' : 'No stills for this day.';
        const t = wantT;
        wantT = null;
        // The minute holding the time, else the nearest one (for now: the newest).
        const target = t === null ? null : nearestMinute(m, t);
        if (target && t !== null) {
          open = target;
          void pick(target, t);
          void reveal();
        }
      },
      (err: Error) => {
        if (stale) return;
        // The proxy answers 404 stills_disabled when it keeps no stills (issue #38).
        message = /HTTP 404/.test(err.message) ? "This camera's cam-proxy keeps no stills." : 'The camera gateway is not reachable right now.';
      },
    );
    return () => (stale = true);
  });

  // A live change on today: refresh in place (the open minute and still stay).
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
        cards = ev;
        if (m.length) message = '';
        if (open) open = m.find((x) => x.minute === open!.minute) ?? open;
      },
      () => undefined,
    );
    return () => (stale = true);
  });

  $effect(() => {
    void $cameras;
    void $liveEventsOn; // follow the setting (off: no live refresh)
    const stop = eventStream()?.watch(() => camera?.id ?? '', () => { if (date === $todayDate) refreshTick++; }, 5000);
    return () => stop?.();
  });

  // The large still is the shared cursor: History and the Timeline continue
  // from it (Klaus, 2026-09-29).
  $effect(() => {
    const cam = camera?.id;
    const ts = still?.ts ?? null;
    if (!cam || ts === null) return;
    saveViewPoint(cam, ts);
    saveCursor(cam, { date: localDate(new Date(ts)), clipId: null, offsetSec: 0, at: ts });
  });

  // The URL follows the view.
  $effect(() => {
    const search = cursorSearch({ cam: camera?.id ?? null, date, t: still?.ts ?? open?.minute ?? null });
    if (search !== location.search) history.replaceState(history.state, '', `${location.pathname}${search}`);
  });

  // Opened at a time: its minute view in the middle of the screen, once.
  async function reveal() {
    await tick();
    document.querySelector<HTMLElement>('[data-testid="timeline-minute-view"]')?.scrollIntoView?.({ block: 'center' });
  }

  function openMinute(m: PreviewMinute) {
    ++pickSeq; // a still still loading for the minute before is dropped
    open = m;
    still = null;
  }

  // The still for a second: the proxy's still at or after it in that minute
  // (the sprite has a tile per second; the proxy may keep fewer stills).
  async function pick(m: PreviewMinute, target: number) {
    const seq = ++pickSeq;
    try {
      const stills = await getJson<number[]>(`${base}/stills?from=${m.minute}&to=${m.minute + 59_999}`);
      if (seq !== pickSeq || !stills.length) return;
      still = { ts: stills[stillIndex(stills, target, 1)], seen: null };
    } catch {
      if (seq === pickSeq) message = 'Could not load that minute.';
    }
  }

  function openSecond(m: PreviewMinute, i: number, seen: SeenStill | null) {
    if (seen) {
      ++pickSeq;
      still = { ts: seen.stillTs, seen };
      return;
    }
    void pick(m, m.minute + i * m.intervalS * 1000);
  }

  const hourHolding = (m: PreviewMinute) => hours.find((h) => h.minutes.some((x) => x.minute === m.minute))?.minutes ?? [];
  function step(dir: -1 | 1) {
    if (!open) return;
    const list = hourHolding(open);
    const next = stepMinute(list, open.minute, dir);
    const m = next === null ? undefined : list.find((x) => x.minute === next);
    if (m) openMinute(m);
  }
  function close() {
    ++pickSeq;
    open = null;
    still = null;
  }
  function onkey(e: KeyboardEvent) {
    if (!open || (e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Escape') {
      if (still) still = null;
      else close();
    } else return;
    e.preventDefault();
  }

  const historyHref = (ts: number) => `/app/recordings?cam=${encodeURIComponent(camera!.id)}&panel=history&at=${ts}`;
  const loadAll = (eventId: number) => async (): Promise<StillObject[]> => (await getJson<{ objects: StillObject[] }>(`${base}/analyses/${eventId}`)).objects;

  // Sprites load when their tile scrolls into view (a day is up to 1440).
  // Each is fetched through an Image first, so a refused one (429 after a
  // burst, 2026-09-29) is tried again after 3, 6, 12 and 24 s instead of
  // leaving an empty tile; the tile shows once its sprite has loaded.
  const RETRY_MS = [3000, 6000, 12_000, 24_000];
  function lazyStyle(node: HTMLElement, arg: { style: string; url: string }) {
    let current = arg;
    let visible = false;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (want: { style: string; url: string }, attempt: number) => {
      const img = new Image();
      img.onload = () => {
        if (!gone && current.url === want.url) node.setAttribute('style', current.style);
      };
      img.onerror = () => {
        if (gone || current.url !== want.url || attempt >= RETRY_MS.length) return;
        timer = setTimeout(() => load(want, attempt + 1), RETRY_MS[attempt]);
      };
      img.src = want.url;
    };
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) {
        visible = true;
        io.disconnect();
        load(current, 0);
      }
    }, { rootMargin: '200px' });
    io.observe(node);
    return {
      update(a: { style: string; url: string }) {
        const changed = a.url !== current.url;
        current = a;
        if (!visible) return;
        if (changed) {
          clearTimeout(timer);
          load(current, 0);
        } else if (node.getAttribute('style')) node.setAttribute('style', a.style);
      },
      destroy: () => {
        gone = true;
        clearTimeout(timer);
        io.disconnect();
      },
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
    {#if message}<p class="muted" data-testid="timeline-message">{message}</p>{/if}
    <p class="muted small">One tile per minute; a coloured edge marks a recording, a purple one what Vision found. Click a minute for its seconds, then a second for its still.</p>
    {#each hours as h (h.minutes[0].minute)}
      <div class="hour" data-testid="timeline-hour">
        <div class="label mono">{String(h.hour).padStart(2, '0')}:00</div>
        <div class="body">
          <div class="tiles">
            {#each h.minutes as m (m.minute)}
              {@const list = cardsInMinute(m, cards)}
              {@const marks = minuteMarks(m, cards)}
              <button class="tile {list.length ? `ev-${cardKind(list[0])}` : ''}" class:active={open?.minute === m.minute} class:analysed={marks.analysed}
                title={clock(m.minute) + (list.length ? ` · ${list.map(labels).join(' · ')}` : '')}
                aria-label={`${clock(m.minute)}${list.length ? `, ${list.map(labels).join('; ')}` : ''}`} aria-expanded={open?.minute === m.minute}
                onclick={() => openMinute(m)} data-testid="timeline-minute" data-minute={m.minute}>
                <span class="img" use:lazyStyle={{ style: tileStyle(m, firstTile(m), 0.5), url: m.url }}></span>
                {#if marks.count > 1}<span class="count" data-testid="timeline-minute-count">×{marks.count}</span>{/if}
              </button>
            {/each}
          </div>
          {#if open && h.minutes.some((x) => x.minute === open!.minute)}
            {@const m = open}
            {@const evs = cardsInMinute(m, cards)}
            {@const kinds = secondKinds(m, cards)}
            {@const seen = analysedSeconds(m, cards)}
            <div class="detail" data-testid="timeline-minute-view">
              <div class="bar">
                <strong class="mono">{clock(m.minute)}</strong>
                <span class="spacer"></span>
                <button data-testid="timeline-minute-prev" title="Previous minute" aria-label="Previous minute" disabled={stepMinute(h.minutes, m.minute, -1) === null} onclick={() => step(-1)}>◀</button>
                <button data-testid="timeline-minute-next" title="Next minute" aria-label="Next minute" disabled={stepMinute(h.minutes, m.minute, 1) === null} onclick={() => step(1)}>▶</button>
                <button data-testid="timeline-close" onclick={close}>Close</button>
              </div>
              {#if evs.length}
                <p class="small" data-testid="timeline-minute-events">
                  {#each evs as e (e.id)}<span class="evtag ev-{cardKind(e)}">{labels(e)} {formatClock(e.start)}–{formatClock(e.end)}</span>{/each}
                </p>
              {/if}
              <div class="seconds">
                {#each m.present as ok, i (i)}
                  {@const ts = m.minute + i * m.intervalS * 1000}
                  <button class="second {kinds[i] ? `ev-${kinds[i]}` : ''}" class:missing={!ok} class:analysed={seen[i] !== null}
                    class:active={still !== null && still.ts >= ts && still.ts < ts + m.intervalS * 1000}
                    disabled={!ok} style={tileStyle(m, i, 0.6)} title={clock(ts, true)} aria-label={`${clock(ts, true)}${seen[i] ? ', analysed by Vision' : ''}`}
                    onclick={() => openSecond(m, i, seen[i])} data-testid="timeline-second" data-ts={ts}>{#if seen[i]}<span class="spark">✦</span>{/if}</button>
                {/each}
              </div>
              {#if still}
                {@const s = still}
                <div class="large" data-testid="timeline-large">
                  <TimelineStill src={`${base}/stills/${s.ts}.jpg`} alt={`${camera.name} at ${clock(s.ts, true)}`} summary={s.seen?.summary ?? null} loadAll={s.seen ? loadAll(s.seen.eventId) : undefined} />
                  <div class="bar">
                    <span class="mono">{clock(s.ts, true)}</span>
                    <!-- History at this second, paused, without boxes (Klaus, 2026-09-30). -->
                    <a data-testid="timeline-open-history" href={historyHref(s.ts)}
                      onclick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate((e.currentTarget as HTMLAnchorElement).getAttribute('href')!); } }}>Open in History</a>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
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
  .small { font-size: 13px; }
  .mono { font-family: var(--mono); }
  .hour { display: grid; grid-template-columns: 52px 1fr; gap: 8px; align-items: start; }
  .label { color: var(--muted); font-size: 12px; padding-top: 4px; }
  .body { display: grid; gap: 8px; min-width: 0; }
  .tiles, .seconds { display: flex; flex-wrap: wrap; gap: 3px; }
  .tile, .second { position: relative; padding: 0; border: 2px solid transparent; border-radius: 4px; background-color: var(--surface-2); background-repeat: no-repeat; cursor: pointer; line-height: 0; }
  .tile:hover, .second:hover:not(:disabled) { border-color: var(--accent); }
  .tile.active { outline: 3px solid var(--accent); outline-offset: 1px; }
  .tile.analysed { box-shadow: 0 0 0 2px #a855f7; }
  .second.analysed { outline: 2px solid #a855f7; outline-offset: 1px; }
  .second.active { outline: 3px solid var(--accent); outline-offset: 1px; }
  .second.missing { opacity: 0.25; cursor: default; }
  .img { display: block; width: 80px; height: 45px; }
  .count { position: absolute; right: 2px; bottom: 2px; background: rgb(0 0 0 / 0.7); color: #fff; font-size: 10px; line-height: 1.3; padding: 0 3px; border-radius: 3px; }
  .spark { position: absolute; top: 1px; left: 3px; color: #a855f7; font-size: 11px; line-height: 1; }
  /* The open minute stands apart from the hour's tiles (cam-proxy, Klaus 2026-09-30). */
  .detail { display: grid; gap: 8px; padding: 10px 12px; border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .bar button { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
  .spacer { flex: 1; }
  .evtag { display: inline-block; margin-right: 10px; padding-left: 6px; border-left: 4px solid; }
  .large { display: grid; gap: 6px; }
  .ev-motion { border-color: #f59e0b; } .ev-person { border-color: #ef4444; } .ev-vehicle { border-color: #3b82f6; } .ev-pet { border-color: #22c55e; } .ev-timer { border-color: var(--muted); }
  @media (max-width: 600px) {
    .hour { grid-template-columns: 1fr; }
  }
</style>
