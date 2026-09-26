<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { COLLAPSE_OVER, FILTERS, TRIGGER_LABELS, formatClock, groupByHour, thumbUrl, type EventClip, type Filter } from '../lib/recordings';

  let {
    cameraId,
    events,
    filter,
    date,
    selectedId,
    onfilter,
    onselect,
  }: {
    cameraId: string;
    events: EventClip[];
    filter: Filter;
    date: string;
    selectedId: string | null;
    onfilter: (f: Filter) => void;
    onselect: (e: EventClip) => void;
  } = $props();

  // Keyed by cameraId|id, not just id: a clip id is only unique within its
  // own camera, so switching cameras without a page reload could otherwise
  // have one camera's broken-thumbnail mark wrongly hide another's.
  let broken = $state(new Set<string>());
  const brokenKey = (id: string) => `${cameraId}|${id}`;

  const groups = $derived(groupByHour(events, date));

  // Open/closed state per `date|hour`, kept once decided so a refresh (new
  // events for the same day arriving) never reopens or re-collapses a
  // group the viewer has already seen. Only actually-new keys get a
  // default computed for them.
  let groupOpen: Record<string, boolean> = $state({});
  const keyOf = (hour: number) => `${date}|${hour}`;

  let listEl: HTMLElement | undefined = $state();
  let internalClick = false;
  let prevSelected: string | null = null;

  $effect(() => {
    const gs = groups;
    const id = selectedId;
    const changed = id !== prevSelected;
    prevSelected = id;
    const updates: Record<string, boolean> = {};
    untrack(() => {
      for (const g of gs) {
        const key = keyOf(g.hour);
        if (!(key in groupOpen)) {
          // A group starts open unless it's busy and doesn't hold the
          // current selection.
          updates[key] = g.events.length <= COLLAPSE_OVER || g.events.some((e) => e.id === id);
        }
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

    if (changed && id && !internalClick) {
      const target = id;
      void tick().then(() => {
        listEl?.querySelector<HTMLElement>(`[data-testid="event-card"][data-clip-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    }
    internalClick = false;
  });

  function toggle(hour: number) {
    const key = keyOf(hour);
    groupOpen = { ...groupOpen, [key]: !groupOpen[key] };
  }

  function select(e: EventClip) {
    internalClick = true;
    onselect(e);
  }
</script>

<div class="filters" role="group" aria-label="Filter events">
  {#each FILTERS as f (f)}
    <button data-testid={`filter-${f}`} aria-pressed={filter === f} onclick={() => onfilter(f)}>{f === 'all' ? 'All' : TRIGGER_LABELS[f]}</button>
  {/each}
</div>

{#if events.length === 0}
  <p class="none" data-testid="no-events">No {filter === 'all' ? '' : TRIGGER_LABELS[filter].toLowerCase() + ' '}events on this day.</p>
{:else}
  <div class="groups" bind:this={listEl}>
    {#each groups as g (g.hour)}
      {@const open = groupOpen[keyOf(g.hour)] ?? true}
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
                    <img class="thumb" data-testid="event-thumb" loading="lazy" alt="" src={thumbUrl(cameraId, e.id)} onerror={() => (broken = new Set([...broken, brokenKey(e.id)]))} />
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
  .placeholder { display: block; }
  .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; }
  .dur { color: var(--muted); font-size: 12px; }
  .tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent-2) 22%, transparent); color: var(--text); }
  .tag.ai { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .none { color: var(--muted); font-size: 14px; }
</style>
