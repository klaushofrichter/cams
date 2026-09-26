<script lang="ts">
  import DayPicker from '../components/DayPicker.svelte';
  import Timeline from '../components/Timeline.svelte';
  import ClipPlayer from '../components/ClipPlayer.svelte';
  import EventList from '../components/EventList.svelte';
  import DownloadList from '../components/DownloadList.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { navigate, route, type Panel } from '../lib/router';
  import { getJson } from '../lib/api';
  import {
    addDays, clipAtSecond, cursorSearch, daysUrl, downloadUrl, eventsUrl, filterEvents, loadCursor, localDate,
    neighbour, parseCursor, saveCursor, secondsIntoDay, videoUrl, type Cursor, type EventClip, type Filter,
  } from '../lib/recordings';

  const today = localDate(new Date());
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

  // The URL is the source of truth; with none (e.g. a sidebar link), the
  // last cursor of this session is restored.
  const parsed = $derived.by(() => {
    const p = parseCursor($route.params, today);
    if (!$route.params.has('date') && !$route.params.has('clip')) {
      const saved = loadCursor();
      if (saved && (!p.cam || saved.cam === p.cam)) return { ...p, cam: saved.cam, cursor: saved.cursor };
    }
    return p;
  });
  const cam = $derived(parsed.cam && $cameras.some((c) => c.id === parsed.cam) ? parsed.cam : $selectedCameraId);
  const cursor: Cursor = $derived(parsed.cursor);
  const filter: Filter = $derived(parsed.filter);
  const panel: Panel = $derived($route.panel);
  const visible = $derived(filterEvents(events, filter));
  const selected = $derived(events.find((e) => e.id === cursor.clipId) ?? null);

  function go(next: Partial<Cursor>, opts: { panel?: Panel; filter?: Filter } = {}) {
    if (!cam) return;
    const c: Cursor = { ...cursor, ...next };
    saveCursor(cam, c);
    navigate(`/app/recordings${cursorSearch(cam, c, opts.panel ?? panel, opts.filter ?? filter)}`);
  }

  // Keep the picker and the page's camera in step.
  $effect(() => {
    if (parsed.cam && parsed.cam !== $selectedCameraId && $cameras.some((c) => c.id === parsed.cam)) selectedCameraId.set(parsed.cam);
  });

  $effect(() => {
    const c = cam;
    const date = cursor.date;
    if (!c) return;
    const seq = ++eventsRequest;
    loading = true;
    failed = false;
    const month = date.slice(0, 7);
    const prevMonth = addDays(`${month}-01`, -1).slice(0, 7);
    Promise.all([
      getJson<{ events: EventClip[] }>(eventsUrl(c, date)),
      getJson<{ days: string[] }>(daysUrl(c, month)),
      getJson<{ days: string[] }>(daysUrl(c, prevMonth)).catch(() => ({ days: [] })),
    ])
      .then(([e, d, dPrev]) => {
        if (seq !== eventsRequest) return;
        events = e.events;
        days = [...new Set([...d.days, ...dPrev.days])].sort();
      })
      .catch(() => {
        if (seq === eventsRequest) failed = true;
      })
      .finally(() => {
        if (seq === eventsRequest) loading = false;
      });
  });

  let lastT = 0;
  function onTime(sec: number) {
    if (!cam || Math.abs(sec - lastT) < 2) return;
    lastT = sec;
    saveCursor(cam, { ...cursor, offsetSec: sec });
  }

  function pickSecond(sec: number) {
    const e = clipAtSecond(events, cursor.date, sec);
    if (e) go({ clipId: e.id, offsetSec: Math.max(0, Math.floor(sec - secondsIntoDay(e.start, cursor.date))) });
  }
</script>

<section class="page">
  <header class="head">
    <h1 data-testid="page-title">Recordings</h1>
    {#if cam}<DayPicker date={cursor.date} {days} {today} onchange={(d) => go({ date: d, clipId: null, offsetSec: 0 })} />{/if}
  </header>

  {#if !cam}
    <div class="placeholder">No cameras are configured.</div>
  {:else}
    <div class="workspace" data-panel={panel}>
      <div class="main">
        <ClipPlayer
          src={selected ? videoUrl(cam, selected.id) : null}
          startAt={cursor.offsetSec}
          hasPrev={!!(selected && neighbour(events, selected.id, -1))}
          hasNext={!!(selected && neighbour(events, selected.id, 1))}
          onprev={() => { const p = selected && neighbour(events, selected.id, -1); if (p) go({ clipId: p.id, offsetSec: 0 }); }}
          onnext={() => { const n = selected && neighbour(events, selected.id, 1); if (n) go({ clipId: n.id, offsetSec: 0 }); }}
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
          <Timeline {events} date={cursor.date} selectedId={cursor.clipId} onpick={pickSecond} />
        {/if}
      </div>

      <aside class="side">
        <div class="tabs" role="tablist">
          {#each TABS as tab (tab.id)}
            <button role="tab" data-testid={`panel-tab-${tab.id}`} aria-selected={panel === tab.id} class:on={panel === tab.id} onclick={() => go({}, { panel: tab.id })}>{tab.label}</button>
          {/each}
        </div>
        {#if panel === 'downloads'}
          <DownloadList cameraId={cam} {events} selectedId={cursor.clipId} />
        {:else}
          <EventList cameraId={cam} events={visible} {filter} selectedId={cursor.clipId}
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
