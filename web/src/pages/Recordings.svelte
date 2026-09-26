<script lang="ts">
  import { untrack } from 'svelte';
  import DayPicker from '../components/DayPicker.svelte';
  import Timeline from '../components/Timeline.svelte';
  import ClipPlayer from '../components/ClipPlayer.svelte';
  import EventList from '../components/EventList.svelte';
  import DownloadList from '../components/DownloadList.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { navigate, replaceRoute, route, type Panel } from '../lib/router';
  import { getJson } from '../lib/api';
  import {
    addDays, clipAtSecond, cursorSearch, daysUrl, downloadUrl, eventsUrl, filterEvents, loadCursor, localDate,
    neighbour, parseCursor, saveCursor, secondsIntoDay, videoUrl, type Cursor, type EventClip, type Filter,
  } from '../lib/recordings';
  import { preferences } from '../lib/preferences';
  import { createTodayRefresher, todayDate } from '../lib/refresh';
  import { formatNow } from '../lib/clock';

  const TABS: { id: Panel; label: string }[] = [
    { id: 'history', label: 'History' },
    { id: 'events', label: 'Events' },
    { id: 'downloads', label: 'Downloads' },
  ];

  let events: EventClip[] = $state([]);
  let days: string[] = $state([]);
  let loading = $state(true);
  let failed = $state(false);
  let eventsRequest = 0;
  let refreshTick = $state(0);
  let updatedAt: Date | null = $state(null);
  let lastKey = '';
  let clipPlayer: { seek: (sec: number) => void } | undefined = $state();

  // The URL is the source of truth; with none (e.g. a sidebar link), the
  // last cursor of this session is restored -- but only when it agrees with
  // whatever camera is already selected elsewhere in the app (the header
  // picker), or there's no picker preference yet (a cold load). Otherwise a
  // session remembered from a previous camera would silently override a
  // camera just picked on another page.
  const parsed = $derived.by(() => {
    const p = parseCursor($route.params, $todayDate);
    if (!$route.params.has('date') && !$route.params.has('clip')) {
      const saved = loadCursor();
      const agrees = p.cam ? saved?.cam === p.cam : $selectedCameraId === null || saved?.cam === $selectedCameraId;
      if (saved && agrees) return { ...p, cam: saved.cam, cursor: saved.cursor };
    }
    return p;
  });
  // A primitive projection of parsed.cam: unlike `parsed` (a fresh object on
  // every route change), this only changes value when the camera in the URL
  // actually changes, so effects that depend on it don't fire on every
  // clip/filter/panel navigation.
  const urlCam = $derived(parsed.cam);
  const cam = $derived(parsed.cam && $cameras.some((c) => c.id === parsed.cam) ? parsed.cam : $selectedCameraId);
  const cursor: Cursor = $derived(parsed.cursor);
  // Likewise, a primitive projection of cursor.date for the events effect.
  const date = $derived(cursor.date);
  // parseCursor already falls back to 'all' when the URL has no filter, so
  // the stored preference is only applied by overriding that case here.
  // Reads the preferences store reactively (not the pref() snapshot helper,
  // which uses get() and would not update this derived value if the
  // preference arrived or changed after the page mounted).
  const filter: Filter = $derived($route.params.has('filter') ? parsed.filter : ($preferences?.eventFilter ?? 'all'));
  const panel: Panel = $derived($route.panel);
  const visible = $derived(filterEvents(events, filter));
  const selected = $derived(events.find((e) => e.id === cursor.clipId) ?? null);

  function go(next: Partial<Cursor>, opts: { panel?: Panel; filter?: Filter } = {}, mode: 'push' | 'replace' = 'push') {
    if (!cam) return;
    const c: Cursor = { ...cursor, ...next };
    saveCursor(cam, c);
    const href = `/app/recordings${cursorSearch(cam, c, opts.panel ?? panel, opts.filter ?? filter)}`;
    if (mode === 'replace') replaceRoute(href);
    else navigate(href);
  }

  // Picking a camera in the header should follow this page to it, keeping
  // the date but starting a fresh clip.
  function switchCamera(newCam: string) {
    const c: Cursor = { ...cursor, clipId: null, offsetSec: 0 };
    saveCursor(newCam, c);
    navigate(`/app/recordings${cursorSearch(newCam, c, panel, filter)}`);
  }

  // Keep the picker and the page's camera in step, in both directions,
  // without looping: each effect tracks only the signals that should drive
  // it, reading everything else through untrack so it isn't re-run by its
  // own side effect.
  //
  // URL -> store: must track $cameras too (not just untrack-read it),
  // otherwise a cold load or deep link (Recordings mounts before the
  // camera list has loaded) never re-checks once the list arrives, and
  // App's own default-selection (list[0]) is left standing instead of the
  // URL's camera.
  $effect(() => {
    const p = urlCam;
    const list = $cameras;
    untrack(() => {
      if (p && p !== $selectedCameraId && list.some((c) => c.id === p)) selectedCameraId.set(p);
    });
  });
  // Store -> URL: the very first value the store takes (null -> whatever
  // App or the effect above sets it to) is initialisation, not a picker
  // action, so it must not be treated as "the user switched cameras" --
  // only a later, real change away from a non-null value should navigate.
  let prevSel: string | null = null;
  $effect(() => {
    const sel = $selectedCameraId;
    const prev = prevSel;
    prevSel = sel;
    untrack(() => {
      if (prev !== null && sel && sel !== prev && sel !== cam && $cameras.some((c) => c.id === sel)) switchCamera(sel);
    });
  });

  // A restored session cursor (no date/clip in the URL) is only ever
  // adopted once; after that the URL itself is canonical.
  let restoredOnce = false;
  $effect(() => {
    const c = cam;
    if (restoredOnce || !c) return;
    if (!$route.params.has('date') && !$route.params.has('clip')) go({}, {}, 'replace');
    restoredOnce = true;
  });

  // Fetches events and the days-with-recordings list; depends only on the
  // camera and the date (both primitives), so selecting a clip, changing
  // the filter or switching panels never re-fetches or remounts the
  // Timeline (which would reset its zoom).
  $effect(() => {
    const c = cam;
    const d = date;
    void refreshTick;
    if (!c) return;
    // A refresh (same cam and date, triggered by the today-refresher) must
    // not clear the list, show the skeleton, or surface an error: the old
    // list stays on screen and a failure is silently ignored.
    const key = `${c}|${d}`;
    const isRefresh = key === lastKey;
    lastKey = key;
    const seq = ++eventsRequest;
    if (!isRefresh) {
      loading = true;
      failed = false;
      events = [];
    }
    const month = d.slice(0, 7);
    const prevMonth = addDays(`${month}-01`, -1).slice(0, 7);
    const dayFetches: Promise<{ days: string[] }>[] = [
      getJson<{ days: string[] }>(daysUrl(c, prevMonth)).catch(() => ({ days: [] })),
    ];
    // Only needed when browsing a past month, so day-next can cross into a
    // month that isn't otherwise loaded.
    if (month < $todayDate.slice(0, 7)) {
      const nextMonth = addDays(`${month}-01`, 32).slice(0, 7);
      dayFetches.push(getJson<{ days: string[] }>(daysUrl(c, nextMonth)).catch(() => ({ days: [] })));
    }
    Promise.all([getJson<{ events: EventClip[] }>(eventsUrl(c, d)), getJson<{ days: string[] }>(daysUrl(c, month)), ...dayFetches])
      .then(([e, d0, ...rest]) => {
        if (seq !== eventsRequest) return;
        events = e.events;
        days = [...new Set([...d0.days, ...rest.flatMap((r) => r.days)])].sort();
        updatedAt = new Date();
        // Always clear the skeleton and any earlier failure on success, even
        // for a refresh (isRefresh never set loading = true above, so a
        // dropped earlier response -- one whose seq no longer matches --
        // would otherwise leave `loading` stuck true forever). A later
        // successful refresh also clears an earlier failed load.
        loading = false;
        failed = false;
      })
      .catch(() => {
        if (seq !== eventsRequest) return;
        // Only the error display is gated on !isRefresh: a refresh failure
        // is silently ignored and the old list stays on screen.
        if (!isRefresh) failed = true;
        loading = false;
      });
  });

  // Refreshes today's events and the days list on its own: every minute
  // while the tab is visible, and once more when it becomes visible again
  // (if enough time has passed). Never touches a past day.
  $effect(() => {
    // Skips a tick while a load (or an earlier refresh) is still in flight,
    // so a slow response never gets raced by a second request that would
    // otherwise get dropped without ever clearing the skeleton.
    const r = createTodayRefresher({ isToday: () => date === $todayDate, refresh: () => { if (!loading) refreshTick++; } });
    return () => r.stop();
  });

  let lastT = 0;
  function onTime(sec: number) {
    if (!cam || Math.abs(sec - lastT) < 2) return;
    lastT = sec;
    saveCursor(cam, { ...cursor, offsetSec: sec });
  }

  function pickSecond(sec: number) {
    const e = clipAtSecond(events, cursor.date, sec);
    if (!e) return;
    const offsetSec = Math.max(0, Math.floor(sec - secondsIntoDay(e.start, cursor.date)));
    // Captured before go(): go() updates the route store, and cursor is
    // derived from it, so reading cursor.clipId after go() would already
    // see the new clip and never detect the "same clip" case below.
    const wasLoaded = e.id === cursor.clipId;
    go({ clipId: e.id, offsetSec });
    // The clicked second may round to the clip already playing, in which
    // case the URL (and so the startAt prop) doesn't change and the player
    // wouldn't otherwise re-seek; seek it directly in that case.
    if (wasLoaded) clipPlayer?.seek(offsetSec);
  }

  function step(dir: -1 | 1) {
    const n = selected && neighbour(visible, selected.id, dir);
    if (n) {
      go({ clipId: n.id, offsetSec: 0 });
      return;
    }
    // Nothing to step from (no clip selected, or the selection is filtered
    // out of the visible list): land on an edge instead of doing nothing.
    jumpToEdge(dir === 1 ? 'start' : 'end');
  }

  function jumpToEdge(edge: 'start' | 'end') {
    if (visible.length === 0) return;
    const target = edge === 'start' ? visible[0] : visible[visible.length - 1];
    go({ clipId: target.id, offsetSec: 0 });
  }
</script>

<section class="page">
  <header class="head">
    <h1 data-testid="page-title">Recordings</h1>
    {#if cam}<DayPicker date={cursor.date} {days} today={$todayDate} onchange={(d) => go({ date: d, clipId: null, offsetSec: 0 })} />{/if}
    {#if cam && date === $todayDate && updatedAt}<span class="updated" data-testid="events-updated">Updated {formatNow(updatedAt)}</span>{/if}
  </header>

  {#if !cam}
    <div class="placeholder">No cameras are configured.</div>
  {:else}
    <div class="workspace" data-panel={panel}>
      <div class="main">
        <ClipPlayer
          bind:this={clipPlayer}
          src={selected ? videoUrl(cam, selected.id) : null}
          startAt={cursor.offsetSec}
          hasPrev={!!(selected && neighbour(visible, selected.id, -1))}
          hasNext={!!(selected && neighbour(visible, selected.id, 1))}
          onprev={() => step(-1)}
          onnext={() => step(1)}
          onauto={() => { const n = selected && neighbour(visible, selected.id, 1); if (n) go({ clipId: n.id, offsetSec: 0 }, {}, 'replace'); }}
          ontime={onTime}
          downloadHref={selected ? downloadUrl(cam, selected.id, 'main') : null}
        />
        {#if loading}
          <div class="bar-skeleton" aria-busy="true"></div>
        {:else if failed}
          <p class="note" role="alert">The recordings could not be loaded. The camera may be offline.</p>
        {:else if events.length === 0}
          <p class="note" data-testid="no-recordings">No recordings on {cursor.date}.</p>
        {:else}
          <Timeline {events} date={cursor.date} selectedId={cursor.clipId} onpick={pickSecond} onstep={step} onedge={jumpToEdge} />
        {/if}
      </div>

      <aside class="side">
        <div class="tabs" role="tablist">
          {#each TABS as tab (tab.id)}
            <button role="tab" data-testid={`panel-tab-${tab.id}`} aria-selected={panel === tab.id} class:on={panel === tab.id} onclick={() => go({}, { panel: tab.id })}>{tab.label}</button>
          {/each}
        </div>
        {#if panel === 'downloads'}
          <DownloadList cameraId={cam} {events} date={cursor.date} selectedId={cursor.clipId} />
        {:else}
          <EventList cameraId={cam} events={visible} {filter} date={cursor.date} selectedId={cursor.clipId}
            onfilter={(f) => go({}, { filter: f })}
            onselect={(e) => go({ clipId: e.id, offsetSec: 0 })} />
        {/if}
      </aside>
    </div>
  {/if}
</section>

<style>
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .head h1 { margin: 0; }
  .updated { color: var(--muted); font-size: 12px; }
  .workspace { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
  .main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .side { display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 170px); overflow: auto; }
  .tabs { display: flex; gap: 6px; }
  .tabs button { padding: 6px 14px; border-radius: 9px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .tabs button.on { background: var(--surface-2); color: var(--text); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .note { color: var(--muted); margin: 0; }
  .bar-skeleton { height: 46px; border-radius: 10px; background: linear-gradient(90deg, var(--surface-2), var(--surface), var(--surface-2)); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: 0 0; } }
  @media (max-width: 1199px) {
    .workspace { grid-template-columns: 1fr; }
    .side { max-height: none; }
  }
</style>
