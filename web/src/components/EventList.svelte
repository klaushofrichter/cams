<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ALL_KINDS, TRIGGER_LABELS, isAllKinds, toggleFilter, defaultGroupOpen, formatClock, groupByHour, thumbUrl, type EventClip, type Filter } from '../lib/recordings';

  let {
    cameraId,
    events,
    filter,
    date,
    selectedId,
    onfilter,
    onselect,
    onthumberror,
    downloadsOk = true,
    pending = [],
  }: {
    cameraId: string;
    events: EventClip[];
    filter: Filter;
    date: string;
    selectedId: string | null;
    onfilter: (f: Filter) => void;
    onselect: (e: EventClip) => void;
    onthumberror?: () => void;
    downloadsOk?: boolean;
    // Live events that started and aren't listed as recordings yet (Klaus, 2026-09-28).
    pending?: { kind: string; ts: number }[];
  } = $props();

  // Keyed by cameraId|id, not just id: a clip id is only unique within its
  // own camera, so switching cameras without a page reload could otherwise
  // have one camera's broken-thumbnail mark wrongly hide another's.
  let broken = $state(new Set<string>());
  const brokenKey = (id: string) => `${cameraId}|${id}`;
  // The key comes from the element, not from this item's reactive state: the
  // error can land while the item re-renders (the derived_inert warnings seen
  // in production), so the handler reads nothing reactive but `broken`.
  // When the camera starts serving recordings again, give the failed
  // thumbnails another try.
  let wasOk = true;
  $effect(() => {
    const ok = downloadsOk;
    if (ok && !wasOk) broken = new Set();
    wasOk = ok;
  });

  function markBroken(ev: Event) {
    const key = (ev.currentTarget as HTMLElement | null)?.dataset.brokenKey;
    if (key) broken = new Set([...broken, key]);
    onthumberror?.();
  }

  const groups = $derived(groupByHour(events, date));

  // Open/closed state per `cameraId|date|hour` -- not just `date|hour`:
  // switching cameras (without changing the date) must not carry over a
  // group's open/closed state from one camera's hour to another camera's
  // same hour, which have nothing to do with each other. Kept once decided
  // so a refresh (new events for the same day arriving) never reopens or
  // re-collapses a group the viewer has already seen. Only actually-new
  // keys get a default computed for them.
  let groupOpen: Record<string, boolean> = $state({});
  const keyOf = (hour: number) => `${cameraId}|${date}|${hour}`;

  let listEl: HTMLElement | undefined = $state();
  // The id a click inside this list just selected, so the effect below can
  // tell that apart from a selection that changed from outside (prev/next,
  // the timeline, a deep link, a cross-day navigation): only the latter
  // ever needs a scroll, since a click can't land on a hidden card.
  let clickedId: string | null = null;
  let prevSelected: string | null = null;
  // The id this list still owes a scroll to. Set on an external selection
  // change and retried (via the effect below, which reruns whenever the
  // groups or their open state change) until the card actually exists in
  // the DOM -- e.g. a deep link or a cross-day prev/next can set the
  // selection before its events have loaded, or before the group holding it
  // has opened -- and is cleared only once that scroll actually happens.
  let pendingScroll: string | null = $state(null);

  $effect(() => {
    const gs = groups;
    const id = selectedId;
    const changed = id !== prevSelected;
    prevSelected = id;
    const wasClicked = id !== null && id === clickedId;
    clickedId = null;
    const updates: Record<string, boolean> = {};
    untrack(() => {
      for (const g of gs) {
        const key = keyOf(g.hour);
        if (!(key in groupOpen)) updates[key] = defaultGroupOpen(g, id);
      }
      // The selection moved (via prev/next, the timeline or a deep link) into
      // a group that's collapsed: open it. A click inside this list can't
      // land on a hidden card, so this only ever fires for an outside move.
      if (changed && id) {
        const g = gs.find((g) => g.events.some((e) => e.id === id));
        if (g) {
          const key = keyOf(g.hour);
          const willBeOpen = key in updates ? updates[key] : groupOpen[key];
          if (willBeOpen === false) updates[key] = true;
        }
      }
    });
    if (Object.keys(updates).length) groupOpen = { ...groupOpen, ...updates };

    if (changed && id && !wasClicked) pendingScroll = id;
  });

  // Tries to scroll to `pendingScroll`'s card, retrying (via `groupOpen` and
  // `groups`, read below so this effect reruns as they change) until the
  // card is actually found, and clearing it only then.
  $effect(() => {
    const target = pendingScroll;
    if (!target) return;
    void groups;
    void groupOpen;
    void tick().then(() => {
      // This effect can re-run (groups/groupOpen changing again before the
      // first run's tick() resolves) and queue more than one of these
      // callbacks for the same target; only the first to actually run
      // should scroll -- a later, now-stale one must see pendingScroll
      // already cleared and do nothing.
      if (pendingScroll !== target) return;
      const el = listEl?.querySelector<HTMLElement>(`[data-testid="event-card"][data-clip-id="${CSS.escape(target)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest' });
      pendingScroll = null;
    });
  });

  function toggle(hour: number) {
    const key = keyOf(hour);
    groupOpen = { ...groupOpen, [key]: !groupOpen[key] };
  }

  function select(e: EventClip) {
    clickedId = e.id;
    onselect(e);
  }
</script>

<div class="filters" role="group" aria-label="Filter events">
  <!-- Several kinds at once; All is every kind (Klaus, 2026-09-28). -->
  <button data-testid="filter-all" aria-pressed={isAllKinds(filter)} onclick={() => onfilter(toggleFilter(filter, 'all'))}>All</button>
  {#each ALL_KINDS as f (f)}
    <button data-testid={`filter-${f}`} aria-pressed={!isAllKinds(filter) && filter.includes(f)} onclick={() => onfilter(toggleFilter(filter, f))}>{TRIGGER_LABELS[f]}</button>
  {/each}
</div>

{#each pending as p (p.ts)}
  <div class="card pending" data-testid="event-pending" role="status">
    <span class="dot" aria-hidden="true"></span>
    <span class="meta">
      <strong>{new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong>
      <span class="tags"><span class="tag">{TRIGGER_LABELS[p.kind as keyof typeof TRIGGER_LABELS] ?? p.kind}</span></span>
      <span class="dur">recording…</span>
    </span>
  </div>
{/each}
{#if events.length === 0 && pending.length === 0}
  <p class="none" data-testid="no-events">No {isAllKinds(filter) ? '' : filter.map((f) => TRIGGER_LABELS[f].toLowerCase()).join(' or ') + ' '}events on this day.</p>
{:else}
  <div class="groups" bind:this={listEl}>
    {#each groups as g (g.hour)}
      {@const open = groupOpen[keyOf(g.hour)] ?? defaultGroupOpen(g, selectedId)}
      <section class="group" data-testid="hour-group" data-hour={g.hour}>
        <button class="group-head" data-testid="hour-toggle" aria-expanded={open} onclick={() => toggle(g.hour)}>
          <span class="label">{g.label}</span>
          <span class="count" data-testid="hour-count">{g.events.length} {g.events.length === 1 ? 'event' : 'events'}</span>
        </button>
        {#if open}
          <ul class="list">
            {#each g.events as e (e.id)}
              <li>
                <button class="card" data-testid="event-card" data-clip-id={e.id} aria-current={e.id === selectedId ? 'true' : undefined} onclick={() => select(e)}>
                  {#if broken.has(brokenKey(e.id))}
                    <span class="thumb placeholder" data-testid="event-thumb"></span>
                  {:else}
                    <img class="thumb" data-testid="event-thumb" loading="lazy" alt="" src={thumbUrl(cameraId, e.id)} data-broken-key={brokenKey(e.id)} onerror={markBroken} />
                  {/if}
                  <span class="meta">
                    <strong>{formatClock(e.start)}</strong>
                    <span class="dur">{e.durationSec} s</span>
                    <span class="tags">
                      {#each e.triggers as t (t)}<span class="tag" class:ai={t !== 'motion' && t !== 'timer'}>{TRIGGER_LABELS[t]}</span>{/each}
                    </span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  .filters { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
  .filters button { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .filters button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); border-color: var(--accent); }
  .groups { display: flex; flex-direction: column; gap: 10px; }
  .group-head {
    position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface);
    color: var(--text); font-size: 12px; cursor: pointer;
  }
  .group-head .label { font-weight: 600; }
  .group-head .count { color: var(--muted); }
  .list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .card {
    width: 100%; display: flex; gap: 10px; align-items: center; padding: 6px; border-radius: 10px; text-align: left;
    border: 1px solid var(--border); background: var(--surface); cursor: pointer; transition: border-color 0.15s ease, background-color 0.15s ease;
  }
  .card:hover { background: var(--surface-2); }
  .card[aria-current='true'] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
  .thumb { width: 96px; height: 54px; object-fit: cover; border-radius: 6px; background: var(--surface-2); flex: none; }
  /* No thumbnail: the same look as the timeline where there is none. */
  .thumb.placeholder { background: var(--no-thumb-bg); }
  .placeholder { display: block; }
  .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; }
  .dur { color: var(--muted); font-size: 12px; }
  .tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent-2) 22%, transparent); color: var(--text); }
  .tag.ai { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .none { color: var(--muted); font-size: 14px; }
  .pending { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; border: 1px dashed var(--accent); background: var(--surface); margin-bottom: 8px; }
  .pending .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); animation: pulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes pulse { 50% { opacity: 0.3; } }
</style>
