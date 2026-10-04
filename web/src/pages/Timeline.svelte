<script lang="ts">
  import { navigate } from '../lib/router';
  import { onMount, tick, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { getJson, HttpError } from '../lib/api';
  import { cameras, cameraById, selectedCameraId } from '../lib/stores';
  import { eventStream } from '../lib/eventStream';
  import { liveEventsOn } from '../lib/preferences';
  import { addDays, DATE, formatClock, localDate, orderTriggers, pad2, TRIGGER_LABELS, type Trigger } from '../lib/recordings';
  import { todayDate } from '../lib/refresh';
  import { localClock, now as clockNow } from '../lib/clock';
  import type { StillObject } from '../lib/vision';
  import TimelineStill from '../components/TimelineStill.svelte';
  import StillCheck from '../components/StillCheck.svelte';
  import ChecksList from '../components/ChecksList.svelte';
  import ComposeDialog from '../components/ComposeDialog.svelte';
  import { checkedMinutes, checkSeconds, loadCheckObjects, loadChecks, loadUsage, stepCheck, withCheck, type CheckResult, type DayCheck, type UsageState } from '../lib/stillChecks';
  import {
    analysedSeconds, blankMinute, cardKind, cardsInMinute, timelineSearch, dayRange, historyHref, hourGroups, loadViewPoint, minuteIndex, minuteOf, nearestMinute, secondStamp, seenStills, shareViewPoint,
    secondKinds, splitRange, stepMinute, stepSecond, stillIndex, tileStyle, timelineCursor, type PreviewMinute, type SeenStill, type TimelineCard,
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
  // The large still; `gap`: a second without one, stepped into (issue #159).
  let still = $state<{ ts: number; gap?: true } | null>(null);
  // The second "Save clip around this" opened the Save dialog at (#179 phase 3).
  let aroundAt = $state<number | null>(null);
  // Vision's analysis of the large still, from the cards: one that arrives
  // with a live refresh shows on a still already open (issue #109).
  const seenStill = $derived.by(() => {
    const ts = still?.ts;
    return ts === undefined ? null : (seenStills(cards).find((x) => x.stillTs === ts) ?? null);
  });
  // Still checks (cams #179): the day's, the budget, the list open or not, and
  // an answer from an event's analysis (no check of its own) for the open second.
  let checks = $state<DayCheck[]>([]);
  let usage = $state<UsageState>({ kind: 'unknown' });
  let showChecks = $state(false);
  let eventAnswer = $state<DayCheck | null>(null);
  const checkHere = $derived.by(() => {
    const ts = still?.ts;
    if (ts === undefined) return null;
    return checks.find((c) => c.stillTs === ts) ?? (eventAnswer?.stillTs === ts ? eventAnswer : null);
  });
  const minutesChecked = $derived(checkedMinutes(checks));
  let pickMessage = $state(''); // in the minute view, next to its seconds (issue #109)
  let refreshTick = $state(0);
  let pickSeq = 0;

  onMount(() => {
    if (initial.cam && $cameras.some((c) => c.id === initial.cam)) selectedCameraId.set(initial.cam);
  });

  const camera = $derived($cameraById($selectedCameraId) ?? null);
  const base = $derived(camera ? `/api/cameras/${encodeURIComponent(camera.id)}` : '');
  // A minute without a sprite that a one-second step opened (issue #159)
  // joins the grid while it is open.
  const shown = $derived(open && !minutes.some((x) => x.minute === open!.minute) ? [...minutes, open].sort((a, b) => a.minute - b.minute) : minutes);
  const hours = $derived(hourGroups(shown));
  // Per minute of the day: its cards, count, colour and Vision mark, once (issue #109).
  const index = $derived(minuteIndex(minutes, cards));
  const firstTile = (m: PreviewMinute) => Math.max(0, m.present.indexOf(true));
  const clock = (ts: number, seconds = false) => localClock(ts, seconds);
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

  // Each camera or day load: a refresh started for an earlier one is dropped.
  let loadSeq = 0;

  // A camera or day change: clear, then load.
  $effect(() => {
    const cam = camera;
    const d = date;
    ++loadSeq;
    minutes = [];
    cards = [];
    checks = [];
    eventAnswer = null;
    open = null;
    still = null;
    newPick(); // a still still loading for the day before is dropped
    message = '';
    if (!cam?.proxy || !DATE.test(d)) return;
    message = 'Loading…';
    let stale = false;
    const b = base;
    void reloadChecks(b, d, () => stale);
    fetchDay(b, d).then(
      ({ m, ev }) => {
        if (stale) return;
        minutes = m;
        cards = ev;
        message = m.length ? '' : 'No stills for this day.';
        const t = wantT;
        const exact = wantExact;
        wantT = null;
        wantExact = false;
        // A one-second step into this day: that very second (issue #159).
        if (exact && t !== null) {
          void goSecond(t);
          void reveal();
          return;
        }
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
    const seq = loadSeq;
    fetchDay(b, d).then(
      ({ m, ev }) => {
        if (stale || seq !== loadSeq) return; // the day or camera changed meanwhile
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
    const stream = eventStream();
    const stop = stream?.watch(() => camera?.id ?? '', () => { if (date === $todayDate) refreshTick++; }, 5000);
    // A new still check, on any day (ruling 9): the day's checks and the budget.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopChecks = stream?.onChange?.((c) => {
      if (c.type !== 'still-check' || c.cam !== untrack(() => camera?.id)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const [b, d] = untrack(() => [base, date] as const);
        void reloadChecks(b, d);
        void refreshUsage();
      }, 300);
    });
    return () => {
      stop?.();
      stopChecks?.();
      clearTimeout(timer);
    };
  });

  // The day's checks (a failed read: none shown, nothing else changes).
  let checksSeq = 0;
  async function reloadChecks(b: string, d: string, stale: () => boolean = () => false) {
    const seq = ++checksSeq;
    const [from, to] = dayRange(d);
    try {
      const list = await loadChecks(b, from, to);
      if (!stale() && seq === checksSeq && b === base && d === date) checks = list;
    } catch {
      // the list stays as it was
    }
  }

  // The budget for the button, per camera.
  async function refreshUsage() {
    const b = base;
    const u = b ? await loadUsage(b) : ({ kind: 'unknown' } as const);
    if (b === base) usage = u;
  }
  $effect(() => {
    const cam = camera;
    usage = { kind: 'unknown' };
    showChecks = false;
    if (cam?.proxy) untrack(() => void refreshUsage());
  });

  // A check made here: into the day's list (an event's answer stays with its second).
  function onCheck(r: CheckResult) {
    if (r.check.id === null) eventAnswer = r.check;
    else if (localDate(new Date(r.check.stillTs)) === date) checks = withCheck(checks, r.check);
  }

  // ◀ ✧ ▶ and Shift+←/→ (ruling 3): the previous or next check of the day.
  function stepToCheck(dir: -1 | 1) {
    const from = still?.ts ?? (dir > 0 ? -Infinity : Infinity);
    const c = stepCheck(checks, from, dir);
    if (c) openCheck(c.stillTs);
  }
  function openCheck(ts: number) {
    newPick();
    void goSecond(ts);
  }

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
    const search = timelineSearch({ cam: camera?.id ?? null, date, t: still?.ts ?? open?.minute ?? wantT });
    if (search !== location.search) history.replaceState(history.state, '', `${location.pathname}${search}`);
  });

  // Opened at a time: its minute view in the middle of the screen, once.
  async function reveal() {
    await tick();
    document.querySelector<HTMLElement>('[data-testid="timeline-minute-view"]')?.scrollIntoView?.({ block: 'center' });
  }

  function openMinute(m: PreviewMinute) {
    newPick(); // a still still loading for the minute before is dropped
    open = m;
    still = null;
    pickMessage = '';
  }
  // A tile toggles its minute (aria-expanded, issue #109).
  const toggleMinute = (m: PreviewMinute) => (open?.minute === m.minute ? close() : openMinute(m));

  // The still for a second: the proxy's still at or after it in that minute
  // (the sprite has a tile per second; the proxy may keep fewer stills).
  async function pick(m: PreviewMinute, target: number) {
    const seq = newPick();
    pickMessage = '';
    try {
      const stills = await getJson<number[]>(`${base}/stills?from=${m.minute}&to=${m.minute + 59_999}`);
      remember(base, m.minute, stills);
      if (seq !== pickSeq) return;
      if (!stills.length) pickMessage = 'No still for that second.';
      else still = { ts: stills[stillIndex(stills, target, 1)] };
    } catch {
      if (seq === pickSeq) pickMessage = 'Could not load that still.';
    }
  }

  function openSecond(m: PreviewMinute, i: number, seen: SeenStill | null, checked: DayCheck | null = null) {
    if (seen || checked) {
      newPick();
      pickMessage = '';
      still = { ts: (seen ?? checked)!.stillTs };
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
    newPick();
    open = null;
    still = null;
    pickMessage = '';
  }
  function onkey(e: KeyboardEvent) {
    // The Save dialog has its own keys (#179 phase 3).
    if (aroundAt !== null) return;
    // Modified keys are the browser's (Alt+← is Back); fields keep their keys.
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return;
    // Shift+arrows: the previous or next still check of the day (cams #179,
    // ruling 3), also before a minute is open.
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (!checks.length) return;
      stepToCheck(e.key === 'ArrowLeft' ? -1 : 1);
      e.preventDefault();
      return;
    }
    if (!open) return;
    // With the large still open the arrows step its second, else the minute (issue #159).
    if (e.key === 'ArrowLeft') (still ? stepStill(-1) : step(-1));
    else if (e.key === 'ArrowRight') (still ? stepStill(1) : step(1));
    else if (e.key === 'Escape') {
      if (still) {
        newPick(); // a still still loading is dropped too
        still = null;
      } else close();
    } else return;
    e.preventDefault();
  }

  // One second back or forward from the large still (issue #159). The steps
  // go through the same selection (open, still) and the same pickSeq guard as
  // a click, so a late still for an earlier second never shows.
  let wantExact = false; // wantT is a step's very second, not "the nearest still"
  // The lower bound. Until /extent answers, or when it fails, there is none:
  // back-steps may then go on into seconds before the oldest still, each
  // showing the gap overlay.
  let oldestStill = $state<number | null>(null);
  $effect(() => {
    const cam = camera;
    oldestStill = null;
    if (!cam?.proxy) return;
    let stale = false;
    getJson<{ oldest?: number | null; stills?: number | null }>(`/api/cameras/${encodeURIComponent(cam.id)}/extent`).then(
      (x) => { if (!stale) oldestStill = typeof x.stills === 'number' ? x.stills : null; },
      () => undefined, // no lower bound then
    );
    return () => (stale = true);
  });
  const bounds = () => ({ oldest: oldestStill, now: Date.now() });

  // A minute's still list, kept for steps through it: a minute that was
  // complete when asked keeps its list, a recent one for two seconds.
  const lists = new Map<string, { at: number; list: Promise<number[]> }>();
  function remember(b: string, minute: number, list: number[]) {
    lists.set(`${b}|${minute}`, { at: Date.now(), list: Promise.resolve(list) });
  }
  function stillsIn(b: string, minute: number): Promise<number[]> {
    const key = `${b}|${minute}`;
    const hit = lists.get(key);
    if (hit && (hit.at > minute + 65_000 || Date.now() - hit.at < 2000)) return hit.list;
    const list = getJson<number[]>(`${b}/stills?from=${minute}&to=${minute + 59_999}`);
    list.catch(() => lists.delete(key));
    lists.delete(key);
    lists.set(key, { at: Date.now(), list });
    if (lists.size > 120) lists.delete(lists.keys().next().value!);
    return list;
  }

  // Quick presses (a held arrow key) coalesce: the first shows at once, then
  // at most one every STEP_MS, always the latest second asked for.
  const STEP_MS = 150;
  let stepTo: number | null = null; // the second the presses aim at, until it shows
  let stepDir: -1 | 1 = 1;
  let stepTimer: ReturnType<typeof setTimeout> | undefined;
  let stepDirty = false;
  // Any other pick: steps still pending are dropped with its still.
  function newPick(): number {
    clearTimeout(stepTimer);
    stepTimer = undefined;
    stepTo = null;
    stepDirty = false;
    return ++pickSeq;
  }
  function stepStill(dir: -1 | 1) {
    const from = stepTo ?? still?.ts;
    if (from === undefined) return;
    const next = stepSecond(from, dir, bounds());
    if (!next) return;
    stepTo = next.ts;
    stepDir = dir;
    if (stepTimer) {
      stepDirty = true;
      return;
    }
    void goSecond(next.ts);
    const flush = () => {
      stepTimer = undefined;
      if (!stepDirty || stepTo === null) return;
      stepDirty = false;
      void goSecond(stepTo);
      stepTimer = setTimeout(flush, STEP_MS);
    };
    stepTimer = setTimeout(flush, STEP_MS);
  }

  // Show a second: its still, or the gap overlay when it has none. Another
  // day loads first (its very second, through wantT).
  async function goSecond(ts: number) {
    const seq = ++pickSeq;
    pickMessage = '';
    const day = localDate(new Date(ts));
    if (day !== date) {
      wantT = ts;
      wantExact = true;
      date = day; // the load effect drops this pick and comes back here
      return;
    }
    const minute = minuteOf(ts);
    const moved = open?.minute !== minute;
    if (moved) open = minutes.find((x) => x.minute === minute) ?? blankMinute(minute, minutes[0]);
    const b = base;
    try {
      const list = await stillsIn(b, minute);
      if (seq !== pickSeq) return;
      const hit = list.find((t) => Math.floor(t / 1000) * 1000 === ts);
      still = hit === undefined ? { ts, gap: true } : { ts: hit };
      if (stepTo === ts && !stepDirty) stepTo = null;
      // The next still the same way, so a further step finds it cached.
      const ahead = list.find((t) => Math.floor(t / 1000) * 1000 === ts + stepDir * 1000);
      if (ahead !== undefined) new Image().src = `${b}/stills/${ahead}.jpg`;
      // Another minute (maybe another hour) moved the minute view: its large
      // still and the step buttons back into view, on a phone too.
      if (moved) {
        await tick();
        if (seq === pickSeq) document.querySelector<HTMLElement>('[data-testid="timeline-large"]')?.scrollIntoView?.({ block: 'nearest' });
      }
    } catch {
      if (seq === pickSeq) pickMessage = 'Could not load that still.';
    }
  }
  const canStep = (dir: -1 | 1, ts: number, nowMs: number) => stepSecond(ts, dir, { oldest: oldestStill, now: nowMs }) !== null;

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
      if (!want.url) return void node.setAttribute('style', want.style); // a minute without a sprite
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
    {#if camera?.proxy}
      <button class="chip" aria-pressed={showChecks} aria-expanded={showChecks} onclick={() => (showChecks = !showChecks)} data-testid="checks-chip">✧ Checks ({checks.length})</button>
    {/if}
  </header>

  {#if !camera}
    <p class="muted">No camera selected.</p>
  {:else if !camera.proxy}
    <p class="muted" data-testid="timeline-no-proxy">{camera.name} has no camera gateway (cam-proxy), so there are no stills to show.</p>
  {:else}
    {#if message}<p class="muted" data-testid="timeline-message">{message}</p>{/if}
    <p class="muted small">One tile per minute; a coloured edge marks a recording, a purple one what Vision found (✦), a dotted purple corner a still checked by hand (✧). Click a minute for its seconds, then a second for its still.</p>
    {#if showChecks}<ChecksList {checks} current={still?.ts ?? null} onopen={openCheck} />{/if}
    {#each hours as h (h.minutes[0].minute)}
      <div class="hour" data-testid="timeline-hour">
        <div class="label mono">{pad2(h.hour)}:00</div>
        <div class="body">
          <div class="tiles">
            {#each h.minutes as m (m.minute)}
              {@const info = index.get(m.minute)}
              {@const list = info?.cards ?? []}
              <button class="tile {info?.kind ? `ev-${info.kind}` : ''}" class:active={open?.minute === m.minute} class:analysed={info?.analysed} class:checked={minutesChecked.has(m.minute)}
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
            {@const marks = checkSeconds(m, checks)}
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
                  <button class="second {kinds[i] ? `ev-${kinds[i]}` : ''}" class:missing={!ok && !marks[i]} class:analysed={seen[i] !== null} class:checked={marks[i] !== null && !seen[i]}
                    class:active={still !== null && still.ts >= ts && still.ts < ts + m.intervalS * 1000}
                    disabled={!ok && !seen[i] && !marks[i]} style={tileStyle(m, i, 0.6)} title={clock(ts, true)} aria-label={`${clock(ts, true)}${seen[i] ? ', analysed by Vision' : marks[i] ? ', checked by Vision' : ''}`}
                    onclick={() => openSecond(m, i, seen[i], marks[i])} data-testid="timeline-second" data-ts={ts}>{#if seen[i]}<span class="spark">✦</span>{:else if marks[i]}<span class="spark" data-testid="timeline-check-mark">✧</span>{/if}</button>
                {/each}
              </div>
              {#if still}
                {@const s = still}
                {@const k = seenStill ? null : checkHere}
                <div class="large" data-testid="timeline-large">
                  {#if s.gap && !k}
                    <!-- A second without a still (an outage, issue #149): said so, and the steps go on (issue #159). -->
                    <div class="gap" style={`aspect-ratio:${m.tileW}/${m.tileH}`} data-testid="timeline-gap" role="status">
                      <span>{secondStamp(s.ts)} not available as snapshot</span>
                    </div>
                  {:else}
                    {#if k}
                      <!-- A checked second: the image Vision saw, its boxes and object list (cams #179). -->
                      <TimelineStill src={k.imageUrl ?? `${base}/stills/${s.ts}.jpg`} alt={`${camera.name} at ${clock(s.ts, true)}, checked by Vision`} summary={k.summary} loadAll={() => loadCheckObjects(base, k)} objectList />
                    {:else}
                      <TimelineStill src={`${base}/stills/${s.ts}.jpg`} alt={`${camera.name} at ${clock(s.ts, true)}`} summary={seenStill?.summary ?? null} loadAll={seenStill ? loadAll(seenStill.eventId) : undefined} />
                    {/if}
                  {/if}
                  <div class="bar">
                    <!-- One second back or forward, across minutes, hours and days (issue #159). -->
                    <button class="sec" data-testid="timeline-second-prev" title="One second back (←)" aria-label="One second back" disabled={!canStep(-1, s.ts, $clockNow.getTime() + 999)} onclick={() => stepStill(-1)}>◀ 1 s</button>
                    <span class="mono" data-testid="timeline-large-time">{clock(s.ts, true)}</span>
                    <button class="sec" data-testid="timeline-second-next" title="One second forward (→)" aria-label="One second forward" disabled={!canStep(1, s.ts, $clockNow.getTime() + 999)} onclick={() => stepStill(1)}>1 s ▶</button>
                    <!-- The previous / next still check of the day (cams #179). -->
                    <button class="chk" data-testid="timeline-check-prev" title="Previous check (Shift+←)" aria-label="Previous check" disabled={!stepCheck(checks, s.ts, -1)} onclick={() => stepToCheck(-1)}>◀ ✧</button>
                    <button class="chk" data-testid="timeline-check-next" title="Next check (Shift+→)" aria-label="Next check" disabled={!stepCheck(checks, s.ts, 1)} onclick={() => stepToCheck(1)}>✧ ▶</button>
                    <span class="spacer"></span>
                    <!-- History at this second, paused, without boxes (Klaus, 2026-09-30). -->
                    <a data-testid="timeline-open-history" href={historyHref(camera.id, s.ts)}
                      onclick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate((e.currentTarget as HTMLAnchorElement).getAttribute('href')!); } }}>Open in Video</a>
                  </div>
                  <StillCheck {base} ts={s.ts} gap={!!s.gap} check={k} analysed={seenStill !== null} {usage} onresult={onCheck} ondone={() => void refreshUsage()} onaround={(t) => (aroundAt = t)} />
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</section>
{#if aroundAt !== null && camera}
  <!-- "Save clip around this" (#179 phase 3): the Save dialog at that second. -->
  <ComposeDialog camera={camera.id} at={aroundAt} stillSrc={still?.gap && still.ts === aroundAt ? undefined : `${base}/stills/${aroundAt}.jpg`} onclose={() => (aroundAt = null)} />
{/if}

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
  /* A minute with a still check: a dotted purple corner (cams #179). */
  .tile.checked::after { content: ''; position: absolute; top: -2px; right: -2px; width: 14px; height: 14px; border-top: 3px dotted var(--vision-mark); border-right: 3px dotted var(--vision-mark); border-top-right-radius: 4px; pointer-events: none; }
  .second.checked { outline: 2px dotted var(--vision-mark); outline-offset: 1px; }
  .chip { font: inherit; font-size: 13px; color: var(--text); background: var(--surface-2); border: 1px dashed var(--vision-mark); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
  .chip[aria-pressed='true'] { background: color-mix(in srgb, var(--vision-mark) 18%, var(--surface-2)); border-style: solid; }
  .second.analysed { outline: 2px solid var(--vision-mark); outline-offset: 1px; }
  .second.active { outline: 3px solid var(--accent); outline-offset: 1px; }
  .second.missing { opacity: 0.25; }
  .second:disabled { cursor: default; }
  .img { display: block; width: 80px; height: 45px; }
  .count { position: absolute; right: 2px; bottom: 2px; background: var(--tile-count-bg); color: var(--tile-count-ink); font-size: 10px; line-height: 1.3; padding: 0 3px; border-radius: 3px; }
  .spark { position: absolute; top: 1px; left: 3px; color: var(--vision-mark); font-size: 11px; line-height: 1; }
  /* The open minute stands apart from the hour's tiles (cam-proxy, Klaus 2026-09-30). */
  .detail { display: grid; gap: 8px; padding: 10px 12px; border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .bar button { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
  .spacer { flex: 1; }
  .evtag { display: inline-block; margin-right: 10px; padding-left: 6px; border-left: 4px solid; }
  .large { display: grid; gap: 6px; }
  .gap { display: grid; place-items: center; width: min(100%, 896px); max-height: 60vh; padding: 16px; box-sizing: border-box; text-align: center; color: var(--muted); background: var(--surface-2); border: 1px dashed var(--border); border-radius: 8px; }
  .gap span { font-family: var(--mono); font-size: 14px; line-height: 1.4; }
  .bar button.sec { min-width: 64px; min-height: 36px; font-variant-numeric: tabular-nums; }
  .bar button.chk { min-height: 36px; color: var(--vision-mark); }
  .bar button:disabled { opacity: 0.45; cursor: default; }
  .ev-motion { border-color: var(--kind-motion); } .ev-person { border-color: var(--kind-person); } .ev-vehicle { border-color: var(--kind-vehicle); } .ev-pet { border-color: var(--kind-pet); } .ev-timer { border-color: var(--muted); }
  @media (max-width: 600px) {
    .hour { grid-template-columns: 1fr; }
    .bar button.sec { min-width: 76px; min-height: 44px; }
    .bar button.chk { min-height: 44px; }
  }
</style>
