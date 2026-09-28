<!-- web/src/components/HistoryView.svelte -->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Strip from './Strip.svelte';
  import StripPlayer from './StripPlayer.svelte';
  import { createStripData, type StripData } from '../lib/stripData';
  import { EMPTY_COVERAGE, windowAround, type Coverage } from '../lib/strip';
  import { filterEvents, localDate, thumbUrl, type EventClip, type Filter } from '../lib/recordings';
  import type { PreviewMinute } from '../lib/timeline';
  import { zoom } from '../lib/zoomPref';

  // History's strip and player (spec 2026-09-27). Owns the position `at`;
  // the page only hears about it (onposition) and can jump it (jump()).
  let {
    cam, proxy, date, initialAt, filter, unavailable, onposition,
  }: {
    cam: string;
    proxy: boolean;
    date: string;
    initialAt: number | null;
    filter: Filter; // the page's event filter: dims the strip, and ←/→ and previous/next skip hidden events
    unavailable: boolean;
    onposition: (at: number, clipId: string | null) => void;
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
  const shown = $derived(filterEvents(allEvents, filter));
  const visibleIds = $derived(new Set(shown.map((e) => e.id)));

  let at = $state(untrack(() => initialAt) ?? new Date(untrack(() => date).replace(/-/g, '/')).getTime());
  let playing = $state(false);
  let placed = untrack(() => initialAt) !== null; // false: move to the day's first event once it loads
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
    if (placed) return;
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

  export function jump(t: number, play = false) {
    at = t;
    placed = true;
    if (play) playing = true;
    report(true);
  }
  // Drag and wheel: many small moves; reported at most every 2 s.
  function seek(t: number) {
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
  <StripPlayer {cam} {coverage} {previews} {now} bind:at bind:playing {unavailable}
    onclipfail={(id) => {
      data.markFailed(id);
      failed = new Set(failed).add(id);
    }}
    onstep={step} />
  <Strip {coverage} events={allEvents} {visibleIds} failedIds={failed} {at} {now} currentId={current} {previews}
    thumbFor={unavailable ? undefined : (id) => thumbUrl(cam, id)}
    onseek={(t) => seek(t)}
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
