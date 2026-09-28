<!-- web/src/components/HistoryView.svelte -->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Strip from './Strip.svelte';
  import StripPlayer from './StripPlayer.svelte';
  import { createStripData, type StripData } from '../lib/stripData';
  import { EMPTY_COVERAGE, windowAround, type Coverage } from '../lib/strip';
  import { localDate, thumbUrl, type EventClip } from '../lib/recordings';
  import type { PreviewMinute } from '../lib/timeline';
  import { zoom } from '../lib/zoomPref';

  // History's strip and player (spec 2026-09-27). Owns the position `at`;
  // the page only hears about it (onposition) and can jump it (jump()).
  let {
    cam, proxy, date, initialAt, visibleIds, unavailable, onposition,
  }: {
    cam: string;
    proxy: boolean;
    date: string;
    initialAt: number | null;
    visibleIds: ReadonlySet<string>;
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
  $effect(() => {
    const d = createStripData(cam, proxy);
    data = d;
    failed = new Set();
    const u1 = d.coverage.subscribe((c) => (coverage = c));
    const u2 = d.previews.subscribe((p) => (previews = p));
    return () => {
      u1();
      u2();
      d.destroy();
    };
  });

  let at = $state(untrack(() => initialAt) ?? new Date(untrack(() => date).replace(/-/g, '/')).getTime());
  let playing = $state(false);
  let placed = untrack(() => initialAt) !== null; // false: move to the day's first event once it loads
  let dragResume = false;

  const events: EventClip[] = $derived(coverage.clips.map((c) => c.clip));
  const current = $derived(coverage.clips.find((c) => at >= c.start && at < c.end)?.clip.id ?? null);

  // Load what the window (and one day either side) needs, and stills around the playhead.
  $effect(() => {
    const w = windowAround(at, $zoom);
    untrack(() => data.ensure(w.start, w.end));
  });
  $effect(() => {
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
      placed = false;
      at = dayStart(d);
      report(true);
    });
  });

  function dayStart(d: string) {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd).getTime();
  }

  // Position reports: at once for jumps, else at most every 2 s.
  let lastReport = 0;
  function report(force = false) {
    const t = Date.now();
    if (!force && t - lastReport < 2000) return;
    lastReport = t;
    onposition(at, current);
  }
  $effect(() => {
    void at;
    untrack(() => report(false));
  });
  $effect(() => {
    void current;
    untrack(() => report(true));
  });

  export function jump(t: number, play = false) {
    at = Math.min(t, now);
    placed = true;
    if (play) playing = true;
    report(true);
  }
  function step(dir: -1 | 1) {
    const list = coverage.clips;
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
  <Strip {coverage} {events} {visibleIds} failedIds={failed} {at} {now} currentId={current} {previews}
    thumbFor={unavailable ? undefined : (id) => thumbUrl(cam, id)}
    onseek={(t) => jump(t)}
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
