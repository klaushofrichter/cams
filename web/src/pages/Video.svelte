<script lang="ts">
  import { untrack } from 'svelte';
  import DayPicker from '../components/DayPicker.svelte';
  import HistoryView from '../components/HistoryView.svelte';
  import EventList from '../components/EventList.svelte';
  import { historySeek, saveViewPoint } from '../lib/timeline';
  import LiveBox from '../components/LiveBox.svelte';
  import LivePanel from '../components/LivePanel.svelte';
  import { cameras, cameraById, selectedCameraId } from '../lib/stores';
  import { navigate, replaceRoute, route, type Panel } from '../lib/router';
  import { getJson } from '../lib/api';
  import { loadDay, sourceLabel, type Downloads } from '../lib/dayCache';
  import { clipStartFromId } from '../lib/strip';
  import {
    addDays, cursorSearch, daysUrl, filterEvents, loadCursor, localDate,
    ALL_KINDS, filterParam, parseCursor, parseFilter, recentEvents, saveCursor, type Cursor, type EventClip, type Filter,
  } from '../lib/recordings';
  import { eventFilter, pickEventFilter } from '../lib/eventFilter';
  import { liveEventsOn, preferences } from '../lib/preferences';
  import { createTodayRefresher, todayDate } from '../lib/refresh';
  import { eventStream, prunePending, type Pending } from '../lib/eventStream';
  import { formatNow } from '../lib/clock';
  import { createKeepAlive } from '../lib/keepAlive';
  import { checkLiveStatus, liveStreamHeld } from '../lib/liveUi';

  // One page for Live and History (spec 2026-09-28; Downloads joined History
  // on 2026-09-29, a download button on each card): the player
  // column never changes, the panel on the right does. On Live the strip's
  // right end is the live stream. App keeps this page mounted (hidden) while
  // the live stream is kept alive after leaving it.
  let { pageVisible = true, tabVisible = true }: { pageVisible?: boolean; tabVisible?: boolean } = $props();

  const TABS: { id: Panel; label: string }[] = [
    { id: 'live', label: 'Live' },
    { id: 'history', label: 'History' },
  ];

  let events: EventClip[] = $state([]);
  let days: string[] = $state([]);
  let loading = $state(true);
  let failed = $state(false);
  // Whether the camera serves recording downloads (server-side breaker, see
  // server/recordings/service.ts). Comes with every events load, and is
  // re-checked shortly after a thumbnail or clip fails to load.
  let downloads: Downloads = $state('ok');
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  function recheckDownloads() {
    if (recheckTimer) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      const c = cam;
      if (!c) return;
      loadDay(c, cursor.date, { force: true })
        .then((r) => {
          if (c === cam) downloads = r.downloads;
        })
        .catch(() => {});
    }, 2000);
  }
  $effect(() => () => {
    if (recheckTimer) clearTimeout(recheckTimer);
  });
  let eventsRequest = 0;
  let refreshTick = $state(0);
  let updatedAt: Date | null = $state(null);
  let lastKey = '';
  // The neighbouring months' days of the last full load (see below).
  let neighbourDays: { key: string; days: string[] } | null = null;
  // Live events of this camera that started and aren't listed yet (Klaus,
  // 2026-09-28): at the top of the list and on the strip right away.
  let pending: Pending[] = $state([]);
  let pendingFor: string | null = null;
  $effect(() => {
    void $cameras; // the stream opens once the camera list is in
    const on = $liveEventsOn;
    const c = cam;
    // Cleared only for another camera or with live events off (not when the
    // camera list or other preferences reload).
    untrack(() => {
      if (c !== pendingFor || !on) pending = [];
    });
    pendingFor = c;
    const stream = on ? eventStream() : undefined;
    if (!c || !stream) return;
    return stream.onCameraEvent((e) => {
      if (e.cam === c) pending = [...pending.filter((p) => p.ts !== e.ts || p.kind !== e.kind), { kind: e.kind, ts: e.ts }];
    });
  });
  $effect(() => {
    const evs = events;
    untrack(() => prune(evs));
  });
  $effect(() => {
    const id = setInterval(() => prune(events), 30_000);
    return () => clearInterval(id);
  });
  // A new array only when something was pruned: everything that reads
  // `pending` would otherwise recompute for nothing.
  function prune(evs: EventClip[]) {
    const next = prunePending(pending, evs, Date.now());
    if (next.length !== pending.length) pending = next;
  }

  // The route this page reads: frozen while it is kept alive behind another
  // page, so that page's URL (a Timeline day, its camera) never moves it.
  let vroute = $state(untrack(() => $route));
  $effect(() => {
    const r = $route;
    if (r.page === 'video') vroute = r;
  });

  let historyView: { jump: (at: number, play?: boolean) => void; position: () => number } | undefined = $state();
  // History's hour groups: "Collapse hours" / "Expand hours" (Klaus, 2026-09-29).
  let eventList: { setAllHours: (open: boolean) => void } | undefined = $state();
  let hoursOpen = $state(true);
  // A tap on a card's thumbnail brings the player into view when it has
  // scrolled away (the phone layout); on the desktop it never has.
  let mainEl: HTMLElement | undefined = $state();
  function revealPlayer() {
    if (mainEl && mainEl.getBoundingClientRect().top < 0) mainEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  // Glued: the Live panel's playhead is at now and the player shows live.
  let glued = $state(untrack(() => $route.panel === 'live' && !$route.params.has('at')));
  // Each navigation to the Live panel without a position (menu, tab,
  // /app/live) goes to live: an event per route, not a flag that can stay
  // set (final review).
  $effect(() => {
    const r = vroute;
    untrack(() => {
      if (r.panel === 'live' && !r.params.has('at')) glued = true;
    });
  });

  // Leaving the live stream (into playback, another panel or page, or a
  // hidden tab) keeps it open for the keep-alive time; coming back within it
  // shows the picture at once (Klaus, 2026-09-28).
  let liveWanted = $state(false);
  const liveKeep = createKeepAlive(() => (liveWanted = false));
  const onLive = $derived(glued && vroute.panel === 'live' && pageVisible && tabVisible);
  let leftWith: number | null = null;
  $effect(() => {
    const seconds = $preferences?.liveKeepAlive ?? 60;
    if (onLive) {
      liveWanted = true;
      leftWith = null;
      liveKeep.enter();
    } else if (untrack(() => liveWanted) && leftWith !== seconds) {
      // Just left, or the keep-alive changed while away: (re)start the
      // countdown with the new time ("off" ends it at once).
      leftWith = seconds;
      liveKeep.leave(seconds);
    }
  });
  $effect(() => () => liveKeep.dispose());
  $effect(() => {
    liveStreamHeld.set(liveWanted);
  });
  $effect(() => () => liveStreamHeld.set(false));
  // Another camera while the stream is only kept alive: end it at once; it
  // starts fresh on the new camera when live is on screen again.
  let liveCamera: string | null | undefined;
  $effect(() => {
    const id = cam;
    untrack(() => {
      if (liveCamera !== undefined && id !== liveCamera && liveWanted && !onLive) {
        liveKeep.enter(); // cancels the countdown: nothing left to expire
        liveWanted = false;
      }
    });
    liveCamera = id;
  });
  // Live and History are one strip (Klaus, 2026-09-28): leaving live on the
  // Live panel (strip, ±10 s, an event) is History at that moment, and the
  // menu and tabs say so. Pushed, so Back returns to Live.
  $effect(() => {
    if (panel !== 'live' || glued || !pageVisible || !cam) return;
    untrack(() => {
      const t = historyView?.position() ?? Date.now();
      const c: Cursor = { date: localDate(new Date(t)), clipId: null, offsetSec: 0, at: t };
      reportedAt = Math.floor(t);
      saveCursor(cam, c);
      // An old /app/live?at= link (earlier versions wrote them) is replaced,
      // so Back doesn't land on it and bounce here again.
      if (vroute.params.has('at')) replaceRoute(hrefFor(cam, c, 'history'));
      else navigate(hrefFor(cam, c, 'history'));
    });
  });
  // History: ⇥ while playing, or playback catching up with now, is Live.
  // Never from behind another page (kept alive): that page owns the URL.
  function toLive() {
    if (pageVisible) navigate('/app/live');
  }

  let proxyInfo: { reachable: boolean; webUrl: string | null } | null = $state(null);
  $effect(() => {
    const c = cam;
    proxyInfo = null;
    if (!c || !$cameraById(c)?.proxyConfigured) return;
    let stale = false;
    getJson<{ reachable: boolean; webUrl: string | null }>(`/api/cameras/${encodeURIComponent(c)}/proxy/info`)
      .then((r) => { if (!stale) proxyInfo = r; })
      .catch(() => {});
    return () => (stale = true);
  });
  let playheadClip: string | null = $state(null);

  // The URL is the source of truth; with none (e.g. a sidebar link), the
  // last cursor of this session is restored -- but only when it agrees with
  // whatever camera is already selected elsewhere in the app (the header
  // picker), or there's no picker preference yet (a cold load). Otherwise a
  // session remembered from a previous camera would silently override a
  // camera just picked on another page.
  const parsed = $derived.by(() => {
    const p = parseCursor(vroute.params, $todayDate);
    if (vroute.panel !== 'live' && !vroute.params.has('date') && !vroute.params.has('clip') && !vroute.params.has('at')) {
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
  const pendingToday = $derived(cursor.date === $todayDate ? [...pending].sort((a, b) => b.ts - a.ts) : []);
  // Likewise, a primitive projection of cursor.date for the events effect.
  const date = $derived(cursor.date);

  // The event filter is one preference for History and Live (Klaus,
  // 2026-10-03, lib/eventFilter.ts): a chip on either panel changes both,
  // across page switches and reloads. URLs carry no filter; an old link's
  // `filter=` is ignored. All until the preferences have loaded.
  // A string first: the list only changes when the kinds do, not on every
  // URL update (every 2 s while playing), so lists and the strip don't
  // recompute (issue #69).
  const filterKey = $derived(filterParam($eventFilter ?? ALL_KINDS));
  const setFilter = (f: Filter) => void pickEventFilter(f);
  // An old link's `filter=` is dropped from the address bar (ignored above).
  $effect(() => {
    if (!pageVisible || !vroute.params.has('filter')) return;
    untrack(() => {
      const u = new URL(location.href);
      u.searchParams.delete('filter');
      replaceRoute(u.pathname + u.search + u.hash);
    });
  });
  const filter: Filter = $derived(parseFilter(filterKey === 'all' ? 'all' : filterKey));
  const panel: Panel = $derived(vroute.panel);
  // The Live panel's camera status: checked on opening it and on another
  // camera, whether or not the stream is open.
  const liveShown = $derived(panel === 'live' && pageVisible);
  $effect(() => {
    if (cam && liveShown) untrack(() => void checkLiveStatus(cam));
  });
  const camProxy = $derived(!!$cameraById(cam)?.proxy);
  const camera = $derived($cameraById(cam) ?? null);
  // The Live panel's recent events: today's five newest that match the
  // filter, newest first (filtered first, not five filtered down).
  const recent = $derived(date === $todayDate ? recentEvents(events, filter, 5) : []);
  const visible = $derived(filterEvents(events, filter));
  // The strip's first position: the URL's `at`, else an old link's clip and
  // offset, else (null) the day's first event.
  const initialAt = $derived(cursor.at ?? (cursor.clipId ? (clipStartFromId(cursor.clipId) ?? 0) + cursor.offsetSec * 1000 || null : null));
  // The strip reports where the playhead is: the URL (date, at, the clip
  // under it) follows, as a replace so the history isn't flooded.
  function onPosition(at: number, clipId: string | null) {
    playheadClip = clipId;
    reportedAt = at;
    // Leaving live on the Live panel: the effect below moves to History.
    if (panel === 'live' && !glued) return;
    // Kept alive behind another page: the URL is that page's.
    if (!cam || !pageVisible) return;
    // The view point the Timeline opens at (Klaus, 2026-09-29): this time,
    // or "now" while Live is showing.
    saveViewPoint(cam, panel === 'live' && glued ? null : at);
    const c: Cursor = { date: localDate(new Date(at)), clipId, offsetSec: 0, at };
    // Live at now keeps the plain /app/live; playback on the Live panel adds `at`.
    if (panel !== 'live') saveCursor(cam, c);
    replaceRoute(hrefFor(cam, panel === 'live' && glued ? { ...c, clipId: null, at: null } : c, panel));
  }
  // The Live panel keeps its own URL; `at` only while it plays back.
  function hrefFor(c0: string, c: Cursor, p: Panel) {
    if (p === 'live') return c.at === null ? '/app/live' : `/app/live${cursorSearch(c0, c, p)}`;
    return `/app/recordings${cursorSearch(c0, c, p)}`;
  }

  function go(next: Partial<Cursor>, opts: { panel?: Panel } = {}, mode: 'push' | 'replace' = 'push') {
    if (!cam) return;
    const p = opts.panel ?? panel;
    // Opening the Live panel goes to live, at now.
    const c: Cursor = p === 'live' && opts.panel === 'live' ? { ...cursor, ...next, clipId: null, offsetSec: 0, at: null } : { ...cursor, ...next };
    if (p !== 'live') saveCursor(cam, c);
    const href = hrefFor(cam, c, p);
    if (mode === 'replace') replaceRoute(href);
    else navigate(href);
  }

  // Picking a camera in the header should follow this page to it, keeping
  // the date but starting a fresh clip.
  function switchCamera(newCam: string) {
    const c: Cursor = { ...cursor, clipId: null, offsetSec: 0, at: null };
    if (panel !== 'live') saveCursor(newCam, c);
    navigate(hrefFor(newCam, c, panel));
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
      // Not while kept alive behind another page: that page owns the URL.
      if (pageVisible && prev !== null && sel && sel !== prev && sel !== cam && $cameras.some((c) => c.id === sel)) switchCamera(sel);
    });
  });

  // Entering History without a position (a sidebar link) puts
  // the restored session cursor into the URL; after that the URL is
  // canonical. On every entry: the page stays mounted across pages now.
  $effect(() => {
    const c = cam;
    if (!c || !pageVisible) return;
    if (panel !== 'live' && !vroute.params.has('date') && !vroute.params.has('clip') && !vroute.params.has('at')) untrack(() => go({}, {}, 'replace'));
  });
  // A position from outside (a link, back/forward, a restored cursor) moves
  // the playhead; the page's own reports come back here and are ignored.
  let reportedAt: number | null = null;
  $effect(() => {
    const t = initialAt;
    untrack(() => {
      if (t !== null && (reportedAt === null || Math.abs(t - reportedAt) >= 1000)) historyView?.jump(t);
    });
  });

  // "Open in History" (the Vision dialog): stop at that second, even when
  // History is already there and playing (the URL can't say so then).
  $effect(() => {
    const s = $historySeek;
    if (!s) return;
    untrack(() => {
      if (historyView && s.cam === cam) {
        reportedAt = s.at;
        historyView.jump(s.at);
      }
      historySeek.set(null);
    });
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
      downloads = 'ok'; // another camera or day: don't carry its banner over
    }
    const month = d.slice(0, 7);
    const prevMonth = addDays(`${month}-01`, -1).slice(0, 7);
    const neighbourMonths = [prevMonth];
    // The next month only when browsing a past month, so day-next can cross
    // into a month that isn't otherwise loaded.
    if (month < $todayDate.slice(0, 7)) neighbourMonths.push(addDays(`${month}-01`, 32).slice(0, 7));
    // A refresh asks for the day's own month only: the neighbouring months'
    // days, once all fetched, are kept for the same camera, day and months.
    const nbKey = `${key}|${neighbourMonths.join()}`;
    const neighbours: Promise<string[]> =
      isRefresh && neighbourDays?.key === nbKey
        ? Promise.resolve(neighbourDays.days)
        : Promise.all(neighbourMonths.map((m) => getJson<{ days: string[] }>(daysUrl(c, m)).then((r) => r.days, () => null))).then((lists) => {
            if (lists.every((l) => l !== null)) neighbourDays = { key: nbKey, days: lists.flat() };
            return lists.flatMap((l) => l ?? []);
          });
    Promise.all([loadDay(c, d, { force: isRefresh }), getJson<{ days: string[] }>(daysUrl(c, month)), neighbours])
      .then(([e, d0, nb]) => {
        if (seq !== eventsRequest) return;
        events = e.events;
        downloads = e.downloads;
        days = [...new Set([...d0.days, ...nb])].sort();
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
    // While the camera's cam-proxy streams its events, reloads come from
    // those; the minute poll covers a camera without one, or while it's down.
    void $cameras; // re-run once the camera list (and whether any has a proxy) is known
    void $liveEventsOn; // and when live events are turned on or off
    const stream = eventStream();
    const r = createTodayRefresher({ isToday: () => date === $todayDate, refresh: () => { if (!loading && !stream?.streaming(cam ?? '')) refreshTick++; } });
    const stopWatch = stream?.watch(() => cam ?? '', () => { if (!loading && date === $todayDate) refreshTick++; });
    return () => {
      r.stop();
      stopWatch?.();
    };
  });

</script>

<section class="page">
  <header class="head">
    <!-- Not while kept alive behind another page: that page has the title. -->
    <h1 data-testid={pageVisible ? 'page-title' : undefined}>{panel === 'live' ? 'Live' : 'History'}</h1>
    <!-- Kept in place (only hidden) on Live, so the video doesn't move between panels. -->
    <span class="center" class:off={panel === 'live'}>{#if cam}<DayPicker date={cursor.date} {days} today={$todayDate} onchange={(d) => go({ date: d, clipId: null, offsetSec: 0, at: null })} />{/if}</span>
    <!-- Three fixed columns, so the day picker stays centred whether or not
         "Updated" is shown (Klaus, 2026-09-27). -->
    <span class="updated" class:off={panel === 'live'}>{#if cam && date === $todayDate && updatedAt}<span data-testid={panel === 'live' ? undefined : 'events-updated'}>Updated {formatNow(updatedAt)}</span>{/if}</span>
  </header>

  {#if !cam}
    <div class="placeholder">No cameras are configured.</div>
  {:else}
    <div class="workspace" data-panel={panel}>
      <div class="main" bind:this={mainEl}>
        {#key cam}
          <HistoryView bind:this={historyView} {cam} proxy={camProxy}
            date={cursor.date} {initialAt} {filter}
            unavailable={downloads === 'unavailable'} onposition={onPosition} {pending}
            live={panel === 'live'} bind:glued onlive={panel === 'history' && pageVisible ? toLive : undefined} liveBox={liveWanted ? liveBoxSnippet : undefined} />
        {/key}
        {#if downloads !== 'unavailable' && !loading && !failed}
          <p class="note" data-testid="recordings-source" role="status">Source of recordings and thumbnails: {sourceLabel(downloads)}</p>
        {/if}
        {#if downloads === 'unavailable'}
          <p class="banner" data-testid="recordings-unavailable" role="status">
            The camera isn't serving recordings right now, so clips and thumbnails can't be loaded. This is a camera-side
            problem; the list of recordings still works, and cams checks again every minute.
          </p>
        {/if}
        {#if loading}
          <div class="bar-skeleton" aria-busy="true"></div>
        {:else if failed}
          <p class="note" role="alert">The recordings could not be loaded. The camera may be offline.</p>
        {:else if events.length === 0 && panel !== 'live'}
          <p class="note" data-testid="no-recordings">No recordings on {cursor.date}.</p>
        {/if}
      </div>

      <aside class="side">
        <div class="tabrow">
          <div class="tabs" role="tablist">
            {#each TABS as tab (tab.id)}
              <button role="tab" data-testid={`panel-tab-${tab.id}`} aria-selected={panel === tab.id} class:on={panel === tab.id} onclick={() => go({}, { panel: tab.id })}>{tab.label}</button>
            {/each}
          </div>
          {#if panel === 'history' && visible.length}
            <button class="hours" data-testid="hours-toggle" onclick={() => eventList?.setAllHours(!hoursOpen)}>{hoursOpen ? 'Collapse hours' : 'Expand hours'}</button>
          {/if}
        </div>
        {#if panel === 'live'}
          {#if camera}
            <LivePanel {camera} {recent} pending={pendingToday} proxyInfo={proxyInfo} paused={!liveWanted}
              {filter} onfilter={setFilter}
            onplay={(e) => historyView?.jump(Date.parse(e.start), true)} />
          {/if}
        {:else}
          <EventList bind:this={eventList} cameraId={cam} events={visible} {filter} date={cursor.date} selectedId={playheadClip} pending={pendingToday}
            onreveal={revealPlayer} onhours={(o) => (hoursOpen = o)}
            onfilter={setFilter}
            onselect={(e) => historyView?.jump(Date.parse(e.start), true)} onthumberror={recheckDownloads} downloadsOk={downloads !== 'unavailable'} />
        {/if}
      </aside>
    </div>
  {/if}
</section>

{#snippet liveBoxSnippet()}
  <LiveBox cameraId={cam!} visible={onLive} audible={onLive} proxy={camProxy} />
{/snippet}

<style>
  .banner { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: 13px; background: color-mix(in srgb, var(--danger) 12%, var(--surface)); border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border)); }
  .head { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; margin-bottom: 14px; }
  .head h1 { margin: 0; }
  .updated { color: var(--muted); font-size: 12px; justify-self: end; text-align: right; }
  @media (max-width: 640px) {
    .head { grid-template-columns: 1fr auto; }
    .updated { grid-column: 1 / -1; justify-self: start; }
  }
  @media (max-width: 380px) {
    .head { grid-template-columns: 1fr; }
    .head .center { justify-self: start; }
  }
  /* The player column is as wide as Live's player (--player-max-w), so the
     video keeps its size between pages and the page itself doesn't scroll. */
  /* Wide windows centre the whole app (App.svelte), so the columns are just
     the player and the panel (Klaus, 2026-09-28). */
  .workspace { display: grid; grid-template-columns: minmax(0, var(--player-max-w)) 370px; gap: 18px; align-items: start; }
  .center.off, .updated.off { visibility: hidden; }
  .main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  /* Desktop: the sidebar is a column as tall as the window allows; the tabs,
     "Collapse hours" and the filter stay at its top and only the event list
     (cards and hour titles) scrolls (Klaus, 2026-10-03). A panel marks the
     boxes that give way with side-fill and the list with side-scroll.
     overflow: auto stays as the fallback for content that can't give way. */
  .side { display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 170px); overflow: auto; }
  .tabrow { display: flex; align-items: center; gap: 6px; flex: none; }
  @media (min-width: 1200px) {
    .side :global(.side-fill) { display: flex; flex-direction: column; flex: 0 1 auto; min-height: 0; }
    .side :global(.side-scroll) { flex: 0 1 auto; min-height: 0; overflow: auto; }
  }
  .tabs { display: flex; gap: 6px; }
  .hours { margin-left: auto; padding: 5px 10px; border-radius: 9px; border: 1px solid var(--border); background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
  .hours:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .tabs button { padding: 6px 14px; border-radius: 9px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .tabs button.on { background: var(--surface-2); color: var(--text); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .note { color: var(--muted); margin: 0; }
  .bar-skeleton { height: 46px; border-radius: 10px; background: linear-gradient(90deg, var(--surface-2), var(--surface), var(--surface-2)); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: 0 0; } }
  @media (max-width: 1199px) {
    .workspace { grid-template-columns: minmax(0, var(--player-max-w)); }
    .side { max-height: none; }
  }
</style>
