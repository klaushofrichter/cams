<!-- web/src/components/HistoryView.svelte -->
<script lang="ts">
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import Strip from './Strip.svelte';
  import { getJson } from '../lib/api';
  import StripPlayer from './StripPlayer.svelte';
  import { createStripData, type StripData } from '../lib/stripData';
  import { EMPTY_COVERAGE, windowAround, type Coverage } from '../lib/strip';
  import { filterEvents, localDate, thumbUrl, type EventClip, type Filter } from '../lib/recordings';
  import type { PreviewMinute } from '../lib/timeline';
  import { zoom } from '../lib/zoomPref';

  // History's strip and player (spec 2026-09-27). Owns the position `at`;
  // the page only hears about it (onposition) and can jump it (jump()).
  let {
    cam, proxy, date, initialAt, filter, unavailable, onposition, pending = [],
    live = false, glued = $bindable(untrack(() => live)), liveBox, onlive,
  }: {
    cam: string;
    proxy: boolean;
    date: string;
    initialAt: number | null;
    filter: Filter; // the page's event filter: dims the strip, and ←/→ and previous/next skip hidden events
    unavailable: boolean;
    onposition: (at: number, clipId: string | null) => void;
    pending?: { kind: string; ts: number }[]; // live events not listed yet: marked on the strip
    live?: boolean; // the Live panel: the strip's right end is the live stream (spec 2026-09-28)
    glued?: boolean; // the playhead is glued to now and the player shows live
    liveBox?: Snippet; // the live stream, shown while glued
    onlive?: () => void; // History: ⇥ while playing, or playback catching up, goes to Live (Klaus, 2026-09-28)
  } = $props();

  let now = $state(Date.now());
  const nowTimer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(nowTimer));

  let data: StripData = $state(createStripData(untrack(() => cam), untrack(() => proxy)));
  let coverage: Coverage = $state(EMPTY_COVERAGE);
  let previews: PreviewMinute[] = $state([]);
  let failed = $state(new Set<string>());
  let allEvents: EventClip[] = $state([]);
  $effect(() => {
    const d = createStripData(cam, proxy);
    data = d;
    failed = new Set();
    const u1 = d.coverage.subscribe((c) => (coverage = c));
    const u2 = d.previews.subscribe((p) => (previews = p));
    const u3 = d.events.subscribe((e) => (allEvents = e));
    return () => {
      u1();
      u2();
      u3();
      d.destroy();
    };
  });
  // The left edge: the oldest content the camera and its proxy have (asked
  // again every minute; retention moves it).
  let oldest: number | null = $state(null);
  $effect(() => {
    const c = cam;
    let stale = false;
    const load = () =>
      getJson<{ oldest: number | null }>(`/api/cameras/${encodeURIComponent(c)}/extent`)
        .then((r) => { if (!stale) oldest = typeof r.oldest === 'number' ? r.oldest : null; })
        .catch(() => undefined);
    void load();
    // Not while the tab is hidden; asked again when it shows.
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stale = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });
  // The right edge: now, or the end of the latest known clip (a camera clock
  // ahead of the browser's). Every move is kept within the two.
  // (The clips' end only changes with the events, not with every tick of `now`.)
  const lastEnd = $derived(allEvents.reduce((m, e) => Math.max(m, Date.parse(e.end)), -Infinity));
  const latest = $derived(Math.max(now, lastEnd));
  $effect(() => {
    const t = at;
    const lo = oldest ?? -Infinity;
    if (t < lo) at = lo;
    // Only once the day's events are known: a link to a clip after now (a
    // camera clock ahead) must not be pulled back before that clip is loaded.
    else if (t > latest) {
      const day = untrack(() => data.eventsOn(localDate(new Date(t))));
      if (day === null) return;
      const limit = Math.max(latest, ...day.map((e) => Date.parse(e.end)));
      if (t > limit) at = limit;
    }
  });
  const shown = $derived(filterEvents(allEvents, filter));
  const visibleIds = $derived(new Set(shown.map((e) => e.id)));

  // The Live panel without an `at` opens glued, at now.
  const openLive = untrack(() => glued && initialAt === null);
  let at = $state(untrack(() => initialAt) ?? (openLive ? Date.now() - 2000 : new Date(untrack(() => date).replace(/-/g, '/')).getTime()));
  let playing = $state(false);
  let placed = openLive || untrack(() => initialAt) !== null; // false: move to the day's first event once it loads
  let dragResume = false;
  $effect(() => {
    if (playing) placed = true; // the user took over: a late load must not move the playhead
  });
  const current = $derived(coverage.clips.find((c) => at >= c.start && at < c.end)?.clip.id ?? null);

  // Load what the window (and one day either side) needs, and stills around the
  // playhead; asked again every 30 s so today's data keeps up (the loaders only
  // fetch what is missing or, for today, stale).
  const tick30 = $derived(Math.floor(now / 30_000));
  $effect(() => {
    void tick30;
    const w = windowAround(at, $zoom);
    untrack(() => data.ensure(w.start, w.end));
  });
  $effect(() => {
    void tick30;
    const hour = Math.floor(at / 3_600_000);
    untrack(() => data.ensureStills(hour * 3_600_000));
  });

  // First position without one in the URL: the day's first event, else 00:00.
  $effect(() => {
    void coverage;
    if (placed || glued) return; // live has its position: now
    const list = data.eventsOn(date);
    if (list === null) return;
    placed = true;
    at = list.length ? Date.parse(list[0].start) : dayStart(date);
    report(true);
  });

  // The page changed the date (day picker) to a day the playhead isn't on.
  let lastDate = untrack(() => date);
  $effect(() => {
    const d = date;
    if (d === lastDate) return;
    lastDate = d;
    untrack(() => {
      if (localDate(new Date(at)) === d) return;
      playing = false;
      const list = data.eventsOn(d);
      placed = list !== null; // already loaded: place now; else once it arrives
      at = list && list.length ? Date.parse(list[0].start) : dayStart(d);
      report(true);
    });
  });

  function dayStart(d: string) {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd).getTime();
  }

  // Position reports: at once for jumps, else at most every 2 s, with a
  // trailing report so the last position of a drag, scroll or play is sent.
  let lastReport = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  function report(force = false) {
    const t = Date.now();
    if (!force && t - lastReport < 2000) {
      trailing ??= setTimeout(() => {
        trailing = undefined;
        report(true);
      }, lastReport + 2000 - t);
      return;
    }
    clearTimeout(trailing);
    trailing = undefined;
    lastReport = t;
    onposition(at, current);
  }
  onDestroy(() => clearTimeout(trailing));
  $effect(() => {
    void at;
    untrack(() => report(false));
  });
  $effect(() => {
    void current;
    untrack(() => report(true));
  });

  // Glue (spec 2026-09-28): on the Live panel the playhead follows now and
  // the player shows the live stream. Any move back unglues; ⇥, a click at
  // now, or playback reaching now glues again. History never glues.
  const LIVE_LAG = 2000;
  $effect(() => {
    if (!live) glued = false;
  });
  $effect(() => {
    if (glued) at = now - LIVE_LAG;
  });
  // A move made inside the player (±10 s, keys) changes `at` directly.
  $effect(() => {
    if (glued && at < now - 5000) glued = false;
  });
  // Playback runs at real time, so it never closes the gap to now by itself:
  // past the last clip and within 30 s of now counts as having reached it.
  const CATCH_UP = 30_000;
  $effect(() => {
    if (!glued && playing && current === null && at >= now - CATCH_UP) {
      if (live) {
        playing = false;
        glued = true;
      } else if (onlive) {
        playing = false;
        untrack(() => onlive());
      }
    }
  });
  function glue() {
    if (!live) return;
    playing = false;
    placed = true;
    glued = true;
    at = now - LIVE_LAG;
    report(true);
  }

  export function position(): number {
    return at;
  }
  // `play`: play from there (a card, prev/next while playing); a position
  // from outside (a link such as "Open in History", back/forward) lands paused.
  export function jump(t: number, play = false) {
    glued = false;
    at = t;
    placed = true;
    playing = play;
    report(true);
  }
  // Drag and wheel: many small moves; reported at most every 2 s.
  function seek(t: number) {
    // The strip's right end is live; recordings after now (a camera clock
    // ahead) stay browseable up to it (one Video page, spec 2026-10-04).
    if (live && t >= latest - LIVE_LAG) return glue();
    glued = false;
    at = t;
    placed = true;
    report(false);
  }
  function step(dir: -1 | 1) {
    const list = coverage.clips.filter((c) => visibleIds.has(c.clip.id));
    const target = dir > 0 ? list.find((c) => c.start > at + 500) : [...list].reverse().find((c) => c.start < at - 1500);
    if (target) jump(target.start, playing);
  }
</script>

<div class="history">
  <StripPlayer {cam} {coverage} {previews} {now} bind:at bind:playing {unavailable} {glued} live={liveBox} onglue={live ? glue : undefined}
    onclipfail={(id) => {
      data.markFailed(id);
      failed = new Set(failed).add(id);
    }}
    onstep={step} />
  <Strip {oldest} {pending} {coverage} events={allEvents} {visibleIds} failedIds={failed} {at} {now} currentId={current} {previews}
    thumbFor={unavailable ? undefined : (id) => thumbUrl(cam, id, allEvents.find((e) => e.id === id)?.thumb)}
    onseek={(t) => seek(t)}
    onglue={live ? glue : playing && onlive ? () => { playing = false; onlive(); } : undefined}
    ondrag={(active) => {
      if (active) {
        dragResume = playing;
        playing = false;
      } else if (dragResume) playing = true;
    }}
    onstep={step} />
</div>

<style>
  .history { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
</style>
