<script lang="ts">
  import { FILTERS, TRIGGER_LABELS, formatClock, thumbUrl, type EventClip, type Filter } from '../lib/recordings';

  let {
    cameraId,
    events,
    filter,
    selectedId,
    onfilter,
    onselect,
  }: {
    cameraId: string;
    events: EventClip[];
    filter: Filter;
    selectedId: string | null;
    onfilter: (f: Filter) => void;
    onselect: (e: EventClip) => void;
  } = $props();

  // Keyed by cameraId|id, not just id: a clip id is only unique within its
  // own camera, so switching cameras without a page reload could otherwise
  // have one camera's broken-thumbnail mark wrongly hide another's.
  let broken = $state(new Set<string>());
  const brokenKey = (id: string) => `${cameraId}|${id}`;
</script>

<div class="filters" role="group" aria-label="Filter events">
  {#each FILTERS as f (f)}
    <button data-testid={`filter-${f}`} aria-pressed={filter === f} onclick={() => onfilter(f)}>{f === 'all' ? 'All' : TRIGGER_LABELS[f]}</button>
  {/each}
</div>

{#if events.length === 0}
  <p class="none" data-testid="no-events">No {filter === 'all' ? '' : TRIGGER_LABELS[filter].toLowerCase() + ' '}events on this day.</p>
{:else}
  <ul class="list">
    {#each events as e (e.id)}
      <li>
        <button class="card" data-testid="event-card" data-clip-id={e.id} aria-current={e.id === selectedId ? 'true' : undefined} onclick={() => onselect(e)}>
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

<style>
  .filters { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
  .filters button { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .filters button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); border-color: var(--accent); }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
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
