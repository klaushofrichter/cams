<script lang="ts">
  import { navigate } from '../lib/router';
  import { onMount, tick, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { getJson, HttpError } from '../lib/api';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { eventStream } from '../lib/eventStream';
  import { liveEventsOn } from '../lib/preferences';
  import { addDays, formatClock, localDate, orderTriggers, TRIGGER_LABELS, type Trigger } from '../lib/recordings';
  import { todayDate } from '../lib/refresh';
  import type { StillObject } from '../lib/vision';
  import TimelineStill from '../components/TimelineStill.svelte';
  import {
    analysedSeconds, cardKind, cardsInMinute, cursorSearch, dayRange, historyHref, hourGroups, loadViewPoint, minuteIndex, nearestMinute, seenStills, shareViewPoint,
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
  // A time to open once its day is loaded; the URL keeps it meanwhile (issue #109).
  let wantT = $state<number | null>(sharedAt ?? initial.t);
  let minutes = $state<PreviewMinute[]>([]);
  let cards = $state<TimelineCard[]>([]);
  let message = $state('');
  let open = $state<PreviewMinute | null>(null); // the minute view
  let still = $state<{ ts: number } | null>(null); // the large still
  // Vision's analysis of the large still, from the cards: one that arrives
  // with a live refresh shows on a still already open (issue #109).
  const seenStill = $derived.by(() => {
    const ts = still?.ts;
    return ts === undefined ? null : (seenStills(cards).find((x) => x.stillTs === ts) ?? null);
  });
  let pickMessage = $state(''); // in the minute view, next to its seconds (issue #109)
  let refreshTick = $state(0);
  let pickSeq = 0;

  onMount(() => {
    if (initial.cam && $cameras.some((c) => c.id === initial.cam)) selectedCameraId.set(initial.cam);
  });

  const camera = $derived($cameras.find((c) => c.id === $selectedCameraId) ?? null);
  const base = $derived(camera ? `/api/cameras/${encodeURIComponent(camera.id)}` : '');
  const hours = $derived(hourGroups(minutes));
  // Per minute of the day: its cards, count, colour and Vision mark, once (issue #109).
  const index = $derived(minuteIndex(minutes, cards));
  const firstTile = (m: PreviewMinute) => Math.max(0, m.present.indexOf(true));
  const clock = (ts: number, seconds = false) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  const labels = (c: TimelineCard) => orderTriggers(c.triggers).map((t) => TRIGGER_LABELS[t as Trigger] ?? t).join(', ') || 'Recording';

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
          // An analysed still opens as such, with Vision's boxes.
          const seen = analysedSeconds(target, ev).find((x) => x?.stillTs === t) ?? null;
          if (seen) openSecond(target, 0, seen);
          else void pick(target, t);
          void reveal();
        }
      },
      (err: Error) => {
        if (stale) return;
        // The proxy answers 404 stills_disabled when it keeps no stills (issue #38).
        message = err instanceof HttpError && err.code === 'stills_disabled' ? "This camera's cam-proxy keeps no stills." : 'The camera gateway is not reachable right now.';
      },
    );
    return () => (stale = true);
  });

  // A live change on today: refresh in place (the open minute and still stay).
  // Only the tick: a camera or day change loads through the effect above, once
  // (issue #109).
  $effect(() => {
    if (!refreshTick) return;
    const [cam, d, b] = untrack(() => [camera, date, base] as const);
    if (!cam?.proxy) return;
    let stale = false;
    fetchDay(b, d).then(
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
    shareViewPoint(cam, ts);
  });

  // The URL follows the view.
  $effect(() => {
    const search = cursorSearch({ cam: camera?.id ?? null, date, t: still?.ts ?? open?.minute ?? wantT });
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
    pickMessage = '';
  }
  // A tile toggles its minute (aria-expanded, issue #109).
  const toggleMinute = (m: PreviewMinute) => (open?.minute === m.minute ? close() : openMinute(m));

  // The still for a second: the proxy's still at or after it in that minute
  // (the sprite has a tile per second; the proxy may keep fewer stills).
  async function pick(m: PreviewMinute, target: number) {
    const seq = ++pickSeq;
    pickMessage = '';
    try {
      const stills = await getJson<number[]>(`${base}/stills?from=${m.minute}&to=${m.minute + 59_999}`);
      if (seq !== pickSeq) return;
      if (!stills.length) pickMessage = 'No still for that second.';
      else still = { ts: stills[stillIndex(stills, target, 1)] };
    } catch {
      if (seq === pickSeq) pickMessage = 'Could not load that still.';
    }
  }

  function openSecond(m: PreviewMinute, i: number, seen: SeenStill | null) {
    if (seen) {
      ++pickSeq;
      pickMessage = '';
      still = { ts: seen.stillTs };
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
    pickMessage = '';
  }
  function onkey(e: KeyboardEvent) {
    // Modified keys are the browser's (Alt+← is Back); fields keep their keys.
    if (!open || e.altKey || e.metaKey || e.ctrlKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Escape') {
      if (still) {
        ++pickSeq; // a still still loading is dropped too
        still = null;
      } else close();
    } else return;
    e.preventDefault();
  }

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
              {@const info = index.get(m.minute)}
              {@const list = info?.cards ?? []}
              <button class="tile {info?.kind ? `ev-${info.kind}` : ''}" class:active={open?.minute === m.minute} class:analysed={info?.analysed}
                title={clock(m.minute) + (list.length ? ` · ${list.map(labels).join(' · ')}` : '')}
                aria-label={`${clock(m.minute)}${list.length ? `, ${list.map(labels).join('; ')}` : ''}`} aria-expanded={open?.minute === m.minute}
                onclick={() => toggleMinute(m)} data-testid="timeline-minute" data-minute={m.minute}>
                <span class="img" use:lazyStyle={{ style: tileStyle(m, firstTile(m), 0.5), url: m.url }}></span>
                {#if list.length > 1}<span class="count" data-testid="timeline-minute-count">×{list.length}</span>{/if}
              </button>
            {/each}
          </div>
          {#if open && h.minutes.some((x) => x.minute === open!.minute)}
            {@const m = open}
            {@const evs = index.get(m.minute)?.cards ?? cardsInMinute(m, cards)}
            {@const kinds = secondKinds(m, cards)}
            {@const seen = analysedSeconds(m, cards)}
            <div class="detail" data-testid="timeline-minute-view">
              <div class="bar">
                <strong class="mono">{clock(m.minute)}</strong>
                <span class="muted small" role="status" data-testid="timeline-pick-message">{pickMessage}</span>
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
                    disabled={!ok && !seen[i]} style={tileStyle(m, i, 0.6)} title={clock(ts, true)} aria-label={`${clock(ts, true)}${seen[i] ? ', analysed by Vision' : ''}`}
                    onclick={() => openSecond(m, i, seen[i])} data-testid="timeline-second" data-ts={ts}>{#if seen[i]}<span class="spark">✦</span>{/if}</button>
                {/each}
              </div>
              {#if still}
                {@const s = still}
                <div class="large" data-testid="timeline-large">
                  <TimelineStill src={`${base}/stills/${s.ts}.jpg`} alt={`${camera.name} at ${clock(s.ts, true)}`} summary={seenStill?.summary ?? null} loadAll={seenStill ? loadAll(seenStill.eventId) : undefined} />
                  <div class="bar">
                    <span class="mono">{clock(s.ts, true)}</span>
                    <!-- History at this second, paused, without boxes (Klaus, 2026-09-30). -->
                    <a data-testid="timeline-open-history" href={historyHref(camera.id, s.ts)}
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
  .tile.analysed { box-shadow: 0 0 0 2px var(--vision-mark); }
  .second.analysed { outline: 2px solid var(--vision-mark); outline-offset: 1px; }
  .second.active { outline: 3px solid var(--accent); outline-offset: 1px; }
  .second.missing { opacity: 0.25; }
  .second:disabled { cursor: default; }
  .img { display: block; width: 80px; height: 45px; }
  .count { position: absolute; right: 2px; bottom: 2px; background: rgb(0 0 0 / 0.7); color: #fff; font-size: 10px; line-height: 1.3; padding: 0 3px; border-radius: 3px; }
  .spark { position: absolute; top: 1px; left: 3px; color: var(--vision-mark); font-size: 11px; line-height: 1; }
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
