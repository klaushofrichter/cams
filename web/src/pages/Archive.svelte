<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import ArchivePlayer from '../components/ArchivePlayer.svelte';
  import ArchiveEditDialog from '../components/ArchiveEditDialog.svelte';
  import { getJson } from '../lib/api';
  import { triggerDownload } from '../lib/download';
  import { eventStream } from '../lib/eventStream';
  import { navigate, route } from '../lib/router';
  import { cameras } from '../lib/stores';
  import {
    clickSelect, zipDelays, dateTime, deleteItems, durationText, expiresText, filterItems, formatBytes, headerState, itemKey, labelChoices, listArchive, NO_FILTERS,
    PREDEFINED_LABELS, qualityText, sortItems, stillRecorded, toggleAll, videoHref, zipUrls,
    type ArchiveItem, type EditMode, type Filters, type ProxyState, type SortKey, type SortOrder,
  } from '../lib/archive';

  // The Archive (cams spec 2026-10-05-archive-design): every cam-proxy's
  // archived clips in one list, sortable, filtered, selected one by one, by
  // shift-click ranges or all, with bulk actions; a thumbnail plays the clip.
  // Live: the relayed `archive` message reloads the list.

  let items = $state<ArchiveItem[]>([]);
  let proxies = $state<ProxyState[]>([]);
  let loaded = $state(false);
  let loadError = $state('');
  let sort = $state<SortKey>('created');
  let order = $state<SortOrder>('desc');
  let filters = $state<Filters>({ ...NO_FILTERS });
  let selected = $state(new Set<string>());
  let anchor: string | null = null;
  let playing = $state<ArchiveItem | null>(null);
  let editing = $state<EditMode | null>(null);
  let confirming = $state(false);
  let deleting = $state(false);
  let notice = $state('');
  let highlight = $state<string | null>(untrack(() => $route.params.get('item')));
  let oldest = $state<Record<string, number | null>>({});
  let status = $state<{ via: string; ok: boolean; count?: number; bytes?: number; percentOfDisk?: number | null; warning?: boolean; disk?: { free: number | null } }[]>([]);

  // The phone layout: cards instead of the table (one markup at a time, so a
  // test id names one element).
  const PHONE = '(max-width: 767px)';
  let phone = $state(typeof matchMedia !== 'undefined' && matchMedia(PHONE).matches);

  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const r = await listArchive({ sort, order });
      if (mine !== seq) return;
      items = r.items;
      proxies = r.proxies;
      loadError = '';
      // Keep the selection of clips that are still there.
      const keys = new Set(r.items.map(itemKey));
      if ([...selected].some((k) => !keys.has(k))) selected = new Set([...selected].filter((k) => keys.has(k)));
      void extents();
    } catch {
      if (mine === seq) loadError = 'The Archive could not be loaded.';
    } finally {
      if (mine === seq) loaded = true;
    }
  }
  // Whether each camera still holds a clip's recording: its oldest content.
  async function extents() {
    for (const cam of new Set(items.map((x) => x.camera).filter((c): c is string => !!c))) {
      if (cam in oldest) continue;
      oldest = { ...oldest, [cam]: null };
      getJson<{ oldest: number | null }>(`/api/cameras/${encodeURIComponent(cam)}/extent`).then((e) => (oldest = { ...oldest, [cam]: e.oldest }), () => undefined);
    }
  }
  async function loadStatus() {
    try {
      status = await getJson('/api/archive/status');
    } catch {
      status = [];
    }
  }

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const reloadSoon = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      void load();
      void loadStatus();
    }, 300);
  };
  let stopStream: (() => void) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    void load();
    void loadStatus();
    const s = eventStream();
    if (s) stopStream = s.onArchive(reloadSoon);
    // Without the live stream (live events off): every minute; with it, every
    // 5 minutes in case a message was missed.
    poll = setInterval(() => void load(), s ? 300_000 : 60_000);
    const mq = typeof matchMedia !== 'undefined' ? matchMedia(PHONE) : null;
    const onMq = () => (phone = !!mq?.matches);
    mq?.addEventListener('change', onMq);
    return () => mq?.removeEventListener('change', onMq);
  });
  onDestroy(() => {
    stopStream?.();
    clearTimeout(reloadTimer);
    clearInterval(poll);
  });

  // "Open in Archive": the new clip, highlighted and in view.
  $effect(() => {
    const key = highlight;
    if (!key || !loaded) return;
    void tick().then(() => document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' }));
  });

  const shown = $derived(filterItems(sortItems(items, sort, order), filters));
  const shownKeys = $derived(shown.map(itemKey));
  const head = $derived(headerState(selected, shownKeys));
  const chosen = $derived(items.filter((x) => selected.has(itemKey(x))));
  const labelsOffered = $derived(labelChoices(items, PREDEFINED_LABELS));
  const cameraChoices = $derived.by(() => {
    const m = new Map<string, string>();
    for (const c of $cameras) if (c.proxyConfigured ?? c.proxy) m.set(c.id, c.name);
    for (const x of items) {
      if (x.camera) m.set(x.camera, $cameras.find((c) => c.id === x.camera)?.name ?? x.cameraName);
      else m.set(`?${x.cameraName}`, `${x.cameraName} (not in cams)`);
    }
    return [...m];
  });
  const totalBytes = $derived(items.reduce((n, x) => n + x.bytes, 0));
  const nameOf = (x: ArchiveItem) => (x.camera ? ($cameras.find((c) => c.id === x.camera)?.name ?? x.cameraName) : x.cameraName);

  function sortBy(k: SortKey) {
    if (sort === k) order = order === 'asc' ? 'desc' : 'asc';
    else {
      sort = k;
      order = k === 'name' || k === 'cam' || k === 'labels' ? 'asc' : 'desc';
    }
    void load(); // the proxies' own order; shown at once from the same rule
  }
  function select(e: MouseEvent, key: string) {
    selected = clickSelect(selected, shownKeys, key, e.shiftKey, anchor);
    anchor = key;
  }
  function toggleLabel(l: string) {
    const on = filters.labels.some((x) => x.toLowerCase() === l.toLowerCase());
    filters = { ...filters, labels: on ? filters.labels.filter((x) => x.toLowerCase() !== l.toLowerCase()) : [...filters.labels, l] };
  }
  async function confirmDelete() {
    deleting = true;
    const n = chosen.length;
    const r = await deleteItems(chosen);
    deleting = false;
    confirming = false;
    const gone = new Set(r.removed);
    items = items.filter((x) => !gone.has(itemKey(x)));
    selected = new Set([...selected].filter((k) => !gone.has(k)));
    notice = r.errors.length ? `Deleted ${r.removed.length} of ${n}. ${r.errors[0]}` : `Deleted ${n} clip${n === 1 ? '' : 's'}.`;
    void loadStatus();
  }
  // The ZIP downloads started from this page (unix ms), for the 4-a-minute spacing.
  let zipStarts: number[] = [];
  const zipTimers: ReturnType<typeof setTimeout>[] = [];
  onDestroy(() => zipTimers.forEach(clearTimeout));
  function downloadZip() {
    const urls = zipUrls(chosen);
    // One ZIP per cam-proxy (and 200 clips), at most 4 a minute (never a refused one).
    const now = Date.now();
    const delays = zipDelays(zipStarts, urls.length, now).map((d, i) => Math.max(d, i * 600));
    zipStarts = [...zipStarts.filter((t) => t > now - 60_000), ...delays.map((d) => now + d)];
    urls.forEach((u, i) => zipTimers.push(setTimeout(() => triggerDownload(u), delays[i])));
    const wait = delays.find((d) => d > 2000);
    notice = [urls.length > 1 ? `${urls.length} ZIP files: one per cam-proxy and 200 clips.` : '', wait ? `The cam-proxy takes 4 ZIPs a minute: the next starts in ${Math.ceil(wait / 1000)} s.` : ''].filter(Boolean).join(' ');
  }
  function saved(changed: ArchiveItem[]) {
    const byKey = new Map(changed.map((x) => [itemKey(x), x]));
    items = items.map((x) => byKey.get(itemKey(x)) ?? x);
    if (playing && byKey.has(itemKey(playing))) playing = byKey.get(itemKey(playing))!;
  }
  function openVideo(e: MouseEvent, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  }
  const proxyNote = (p: ProxyState) => {
    const name = $cameras.find((c) => c.id === p.via)?.name ?? p.via;
    return p.error === 'too_old' ? `${name}’s cam-proxy has no Archive yet (an older version).` : `${name}’s cam-proxy didn’t answer; its clips are missing here.`;
  };
  const COLUMNS: [SortKey, string][] = [['name', 'Name'], ['recorded', 'Recorded'], ['cam', 'Camera'], ['duration', 'Duration'], ['quality', 'Quality'], ['size', 'Size'], ['labels', 'Labels'], ['expires', 'Expires'], ['created', 'Archived']];
  const ariaSort = (k: SortKey) => (sort === k ? (order === 'asc' ? 'ascending' : 'descending') : 'none');

  function indeterminate(node: HTMLInputElement, value: boolean) {
    node.indeterminate = value;
    return { update: (v: boolean) => void (node.indeterminate = v) };
  }
  const now = Date.now();
</script>

{#snippet thumb(x: ArchiveItem)}
  <button class="thumb" data-testid="archive-thumb" aria-label={`Play ${x.name}`} onclick={() => (playing = x)}>
    {#if x.urls.thumbnail}<img src={x.urls.thumbnail} alt="" loading="lazy" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />{/if}
    <span class="play"><Icon name="play" size={16} /></span>
  </button>
{/snippet}
{#snippet recorded(x: ArchiveItem)}
  {@const href = videoHref(x)}
  {#if href && x.camera && stillRecorded(x, oldest[x.camera])}
    <a {href} data-testid="archive-recorded" title="Open the recording on the Video page" onclick={(e) => openVideo(e, href)}>{dateTime(x.recordedFrom)}</a>
  {:else}
    <span data-testid="archive-recorded" title={x.camera ? 'The camera no longer holds this recording (retention); the archived clip is all there is.' : 'cams doesn’t know this camera.'}>{dateTime(x.recordedFrom)}<span class="gone" aria-hidden="true"> ·</span></span>
  {/if}
{/snippet}
{#snippet labelList(x: ArchiveItem)}
  <span class="tags">{#each x.labels as l (l)}<span class="tag" data-testid="archive-label">{l}</span>{/each}</span>
{/snippet}

<section class="page archive">
  <h1 data-testid="page-title">Archive</h1>
  <p class="summary" data-testid="archive-summary">
    {#if loaded}{items.length} clip{items.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}{/if}
    {#each status.filter((s) => s.ok) as s (s.via)}
      {#if status.filter((x) => x.ok).length > 1 || s.disk?.free != null}
        <span class:warn={s.warning} data-testid="archive-status">{status.filter((x) => x.ok).length > 1 ? `${$cameras.find((c) => c.id === s.via)?.name ?? s.via}: ` : ''}{s.percentOfDisk ?? 0} % of the disk{s.disk?.free != null ? `, ${formatBytes(s.disk.free)} free` : ''}{s.warning ? ' — over the warning level' : ''}</span>
      {/if}
    {/each}
  </p>
  {#each proxies.filter((p) => !p.ok) as p (p.via)}<p class="note" data-testid="archive-proxy-note">{proxyNote(p)}</p>{/each}
  {#if loadError}<p class="err" role="alert">{loadError}</p>{/if}

  <div class="filters">
    <input type="search" data-testid="archive-search" placeholder="Search names, cameras, labels" aria-label="Search" bind:value={filters.text} />
    <select data-testid="archive-camera" aria-label="Camera" bind:value={filters.camera}>
      <option value="">All cameras</option>
      {#each cameraChoices as [id, name] (id)}<option value={id}>{name}</option>{/each}
    </select>
    {#if phone}
      <select data-testid="archive-sort" aria-label="Sort by" value={`${sort}:${order}`} onchange={(e) => { const [k, o] = (e.currentTarget as HTMLSelectElement).value.split(':'); sort = k as SortKey; order = o as SortOrder; void load(); }}>
        {#each COLUMNS as [k, label] (k)}<option value={`${k}:desc`}>{label} ↓</option><option value={`${k}:asc`}>{label} ↑</option>{/each}
      </select>
    {/if}
    <div class="chips" role="group" aria-label="Filter by label">
      {#each labelsOffered as l (l)}
        {@const on = filters.labels.some((x) => x.toLowerCase() === l.toLowerCase())}
        <button class="chip" class:on aria-pressed={on} data-testid="archive-filter-label" data-label={l} onclick={() => toggleLabel(l)}>{l}</button>
      {/each}
    </div>
  </div>

  {#if selected.size}
    <div class="bulk" data-testid="archive-bulk" role="toolbar" aria-label="Selected clips">
      <span data-testid="archive-selected-count">{selected.size} selected</span>
      <button data-testid="archive-bulk-delete" onclick={() => (confirming = true)}><Icon name="trash" size={16} /> Delete</button>
      <button data-testid="archive-bulk-zip" onclick={downloadZip}><Icon name="download" size={16} /> Download ZIP</button>
      <button data-testid="archive-bulk-labels" onclick={() => (editing = { kind: 'labels', items: chosen })}><Icon name="tag" size={16} /> Set labels</button>
      <button data-testid="archive-bulk-retention" onclick={() => (editing = { kind: 'retention', items: chosen })}>Set retention</button>
      {#if chosen.length === 1}<button data-testid="archive-bulk-edit" onclick={() => (editing = { kind: 'one', item: chosen[0] })}><Icon name="edit" size={16} /> Edit</button>{/if}
      <button class="link" data-testid="archive-clear-selection" onclick={() => (selected = new Set())}>Clear</button>
    </div>
  {/if}
  {#if notice}<p class="note" role="status" data-testid="archive-notice">{notice}</p>{/if}

  {#if loaded && !items.length && !loadError}
    <div class="card empty" data-testid="archive-empty">No clips archived yet. A clip’s Save dialog has an <strong>Archive</strong> button: it keeps the clip on the camera’s cam-proxy, apart from the normal retention.</div>
  {:else if loaded && !shown.length}
    <div class="card empty" data-testid="archive-none-shown">No clip matches the filters.</div>
  {/if}

  {#if shown.length}
    {#if phone}
      <label class="all"><input type="checkbox" data-testid="archive-select-all" checked={head === 'all'} use:indeterminate={head === 'some'} onclick={() => (selected = toggleAll(selected, shownKeys))} /> Select all {shown.length}</label>
      <ul class="cards" data-testid="archive-list">
        {#each shown as x (itemKey(x))}
          {@const key = itemKey(x)}
          <li class="cardrow" class:sel={selected.has(key)} class:hl={highlight === key} data-testid="archive-row" data-key={key}>
            <input type="checkbox" data-testid="archive-select" aria-label={`Select ${x.name}`} checked={selected.has(key)} onclick={(e) => select(e, key)} />
            {@render thumb(x)}
            <div class="info">
              <strong class="name" data-testid="archive-name-cell">{x.name}</strong>
              <span>{@render recorded(x)}</span>
              <span class="muted">{nameOf(x)} · {durationText(x.durationS)} · {qualityText(x.quality)} · {formatBytes(x.bytes)}</span>
              {@render labelList(x)}
              <span class="muted" data-testid="archive-expires">Expires {expiresText(x.expiresAt, now)} · archived {dateTime(x.createdAt).slice(0, 10)}</span>
            </div>
            <button class="icon" data-testid="archive-edit" aria-label={`Edit ${x.name}`} onclick={() => (editing = { kind: 'one', item: x })}><Icon name="edit" size={18} /></button>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="tablewrap">
        <table data-testid="archive-list">
          <thead>
            <tr>
              <th class="sel"><input type="checkbox" data-testid="archive-select-all" aria-label="Select all shown" checked={head === 'all'} use:indeterminate={head === 'some'} onclick={() => (selected = toggleAll(selected, shownKeys))} /></th>
              <th class="th-thumb"><span class="sr">Thumbnail</span></th>
              {#each COLUMNS as [k, label] (k)}
                <th aria-sort={ariaSort(k)}><button class="sort" data-testid={`archive-sort-${k}`} onclick={() => sortBy(k)}>{label}{sort === k ? (order === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>
              {/each}
              <th><span class="sr">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each shown as x (itemKey(x))}
              {@const key = itemKey(x)}
              <tr class:sel={selected.has(key)} class:hl={highlight === key} data-testid="archive-row" data-key={key}>
                <td class="sel"><input type="checkbox" data-testid="archive-select" aria-label={`Select ${x.name}`} checked={selected.has(key)} onclick={(e) => select(e, key)} /></td>
                <td>{@render thumb(x)}</td>
                <td class="name" data-testid="archive-name-cell">{x.name}</td>
                <td class="nowrap">{@render recorded(x)}</td>
                <td>{nameOf(x)}</td>
                <td class="num">{durationText(x.durationS)}</td>
                <td>{qualityText(x.quality)}</td>
                <td class="num nowrap">{formatBytes(x.bytes)}</td>
                <td>{@render labelList(x)}</td>
                <td class="nowrap" data-testid="archive-expires">{expiresText(x.expiresAt, now)}</td>
                <td class="nowrap">{dateTime(x.createdAt).slice(0, 16)}</td>
                <td><button class="icon" data-testid="archive-edit" aria-label={`Edit ${x.name}`} onclick={() => (editing = { kind: 'one', item: x })}><Icon name="edit" size={18} /></button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <p class="muted hint">{phone ? '' : 'Shift-click a box to select a range. '}A recorded time opens the Video page while the camera still holds the recording.</p>
  {/if}
</section>

{#if playing}
  <ArchivePlayer item={playing} onclose={() => (playing = null)} onedit={(x) => (editing = { kind: 'one', item: x })} />
{/if}
{#if editing}
  <ArchiveEditDialog mode={editing} onclose={() => (editing = null)} onsaved={saved} />
{/if}
{#if confirming}
  <Modal title={`Delete ${chosen.length} clip${chosen.length === 1 ? '' : 's'}?`} testid="archive-confirm" onclose={() => (confirming = false)}>
    <p class="confirm-text">The {chosen.length === 1 ? 'clip is' : `${chosen.length} clips are`} removed from the cam-proxy’s Archive for good, with {chosen.length === 1 ? 'its' : 'their'} metadata and thumbnail{chosen.length === 1 ? '' : 's'}.</p>
    <div class="confirm-actions">
      <button data-testid="archive-confirm-cancel" onclick={() => (confirming = false)} data-autofocus>Cancel</button>
      <button class="danger" data-testid="archive-confirm-delete" disabled={deleting} onclick={confirmDelete}>{deleting ? 'Deleting…' : `Delete ${chosen.length} clip${chosen.length === 1 ? '' : 's'}`}</button>
    </div>
  </Modal>
{/if}

<style>
  .archive { display: flex; flex-direction: column; gap: 12px; padding-bottom: 72px; }
  .summary { margin: -8px 0 0; color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .summary .warn { color: var(--danger); font-weight: 600; }
  .note { margin: 0; font-size: 13px; color: var(--muted); }
  .err { margin: 0; color: var(--danger); }
  .muted { color: var(--muted); }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .filters input, .filters select { padding: 7px 10px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; }
  .filters input { flex: 1 1 220px; min-width: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font: inherit; font-size: 12.5px; cursor: pointer; }
  .chip.on { background: color-mix(in srgb, var(--accent) 22%, transparent); border-color: var(--accent); color: var(--text); }
  .bulk { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--accent); box-shadow: var(--shadow); font-size: 13px; }
  .bulk span { font-weight: 600; margin-right: 4px; }
  .bulk button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  .bulk .link { border: 0; background: transparent; color: var(--accent); text-decoration: underline; }
  .empty { font-size: 14px; }
  .tablewrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: middle; }
  thead th { position: sticky; top: 0; background: var(--surface-2); font-weight: 600; color: var(--muted); white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0; }
  tr.sel td, li.sel { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  tr.hl { outline: 2px solid var(--accent-2); outline-offset: -2px; }
  li.hl { box-shadow: inset 0 0 0 2px var(--accent-2); }
  .sort { border: 0; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; padding: 0; }
  th.sel, td.sel { width: 28px; }
  .th-thumb { width: 104px; }
  .name { font-weight: 600; min-width: 160px; overflow-wrap: anywhere; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .nowrap { white-space: nowrap; }
  .thumb { position: relative; display: block; width: 96px; aspect-ratio: 16 / 9; padding: 0; border: 0; border-radius: 6px; overflow: hidden; background: var(--no-thumb-bg); cursor: pointer; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .play { position: absolute; right: 4px; bottom: 4px; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--player-scrim); color: var(--on-grad); }
  .tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .tag { padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent-2) 18%, transparent); color: var(--text); font-size: 12px; }
  a { color: var(--accent); }
  .gone { color: var(--muted); }
  .icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .hint { font-size: 12px; margin: 0; }
  .all { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .cards { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .cardrow { display: grid; grid-template-columns: auto auto 1fr auto; gap: 10px; align-items: start; padding: 10px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); font-size: 13px; }
  .cardrow .info { display: grid; gap: 3px; min-width: 0; }
  .cardrow .thumb { width: 88px; }
  .confirm-text { margin: 0; font-size: 14px; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .confirm-actions button { padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  .confirm-actions .danger { background: var(--danger); color: var(--on-grad); border: 0; }
  @media (max-width: 767px) {
    .bulk { position: fixed; left: 8px; right: 8px; bottom: 8px; top: auto; z-index: 20; }
  }
</style>
