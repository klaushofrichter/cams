<script lang="ts">
  import { boxLabel, capital, pct, type Box, type StillObject, type SummaryEntry } from '../lib/vision';

  // The Timeline's large still (spec 2026-09-30-analytics-in-cams-design): for
  // an analysed second, Vision's summary boxes with labels; "Show all objects"
  // draws everything Vision reported instead. `objectList` (the Vision dialog,
  // issue #158) adds what cam-proxy's Timeline detail has: Boxes / Plain still,
  // and with all objects a list of them where a click shows only that one's box.
  let {
    src,
    alt,
    summary,
    loadAll,
    objectList = false,
    showAll = $bindable(false),
  }: { src: string; alt: string; summary: SummaryEntry[] | null; loadAll?: () => Promise<StillObject[]>; objectList?: boolean; showAll?: boolean } = $props();

  let all = $state<StillObject[] | null>(null);
  let failed = $state(false);

  // An object without coordinates arrives as a zero-area box, or none: not drawn.
  const drawn = (b: Box | null | undefined): Box | null => (b && b.x1 > b.x0 && b.y1 > b.y0 ? b : null);
  // The radio group's name: arrow keys move within it, Tab stops once.
  const uid = $props.id();
  const group = `still-view-${uid}`;
  // The object picked in the list (its index in `all`); null draws them all.
  let selected = $state<number | null>(null);
  // Plain still: no boxes at all, whatever is picked.
  let view = $state<'boxes' | 'plain'>('boxes');
  const listed = $derived(objectList && showAll && all ? all : null);
  const boxes = $derived<{ label: string; box: Box }[]>(
    view === 'plain'
      ? []
      : listed && selected !== null
      ? [listed[selected]].flatMap((o) => {
          const b = o && drawn(o.box);
          return b ? [{ label: boxLabel(o.name, o.score), box: b }] : [];
        })
      : showAll && all
      ? all.flatMap((o) => {
          const b = drawn(o.box);
          return b ? [{ label: boxLabel(o.name, o.score), box: b }] : [];
        })
      : (summary ?? []).flatMap((e) => {
          const b = drawn(e.box);
          return b ? [{ label: boxLabel(e.subtype, e.score), box: b }] : [];
        }),
  );

  // A label sits above its box, from its left edge (issue #109: not clipped):
  // inside the box when the box touches the top, and ending at the box's right
  // edge when the box starts in the picture's right part.
  const TOP = 0.08;
  const pc = (v: number) => `${Math.round(v * 1000) / 10}%`;
  const labelAt = (b: Box) => `${b.x0 > 0.6 ? `right:${pc(1 - b.x1)}` : `left:${pc(b.x0)}`};top:${pc(b.y0)}`;

  // `gen` counts stills: a loadAll answer that arrives after src changed belongs
  // to the previous still and is dropped. `pending` shares one in-flight request
  // between quick on/off/on toggles.
  let gen = 0;
  let pending: Promise<StillObject[]> | null = null;

  // Another still: back to its summary.
  $effect(() => {
    void src;
    gen++;
    pending = null;
    showAll = false;
    all = null;
    failed = false;
    selected = null;
  });

  async function toggle() {
    showAll = !showAll;
    selected = null;
    if (showAll) failed = false;
    if (!showAll || all || !loadAll) return;
    const mine = gen;
    const request = (pending ??= loadAll());
    try {
      const result = await request;
      if (mine === gen) all = result;
    } catch {
      if (mine !== gen) return;
      pending = null;
      failed = true;
      showAll = false;
    }
  }
</script>

<figure>
  <div class="frame">
    <img {src} {alt} data-testid="timeline-still" />
    {#if boxes.length}
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" data-testid="timeline-boxes">
        {#each boxes as b, i (i)}<rect x={b.box.x0} y={b.box.y0} width={b.box.x1 - b.box.x0} height={b.box.y1 - b.box.y0} vector-effect="non-scaling-stroke" />{/each}
      </svg>
      {#each boxes as b, i (i)}<span class="label" class:inside={b.box.y0 < TOP} data-testid="timeline-box-label" style={labelAt(b.box)}>{b.label}</span>{/each}
    {/if}
  </div>
  {#if summary && (loadAll || objectList)}
    <div class="small">
      {#if objectList}
        <fieldset class="view" data-testid="still-view">
          <legend class="sr">Image</legend>
          <label><input type="radio" name={group} value="boxes" bind:group={view} data-testid="still-view-boxes" /> Boxes</label>
          <label><input type="radio" name={group} value="plain" bind:group={view} data-testid="still-view-plain" /> Plain still</label>
        </fieldset>
      {/if}
      {#if loadAll}
        <label><input type="checkbox" checked={showAll} onchange={() => void toggle()} data-testid="timeline-show-all" /> Show all objects</label>
        <span class="muted" role="status" data-testid="timeline-show-all-failed">{failed ? 'Could not load all objects.' : ''}</span>
      {/if}
    </div>
  {/if}
  {#if listed}
    <ul class="objects" aria-label="Objects" data-testid="still-objects">
      {#each listed as o, i (i)}
        <li>
          <button type="button" class:sel={selected === i} aria-pressed={selected === i} onclick={() => (selected = selected === i ? null : i)} data-testid="still-object">
            <span class="name">{capital(o.name)}</span>{#if !drawn(o.box)}<span class="muted nobox">no box</span>{/if}<span class="score">{pct(o.score)}</span>
          </button>
        </li>
      {:else}
        <li class="muted">Nothing found.</li>
      {/each}
    </ul>
  {/if}
</figure>

<style>
  figure { margin: 0; display: grid; gap: 6px; }
  /* The frame shrink-wraps the image (fit-content, no object-fit): when max-height
     caps the image, the frame narrows with it, so the box overlay and the %-placed
     labels always cover exactly the drawn image and never a letterbox. */
  .frame { position: relative; line-height: 0; width: fit-content; max-width: 100%; }
  img { display: block; max-width: 100%; max-height: 60vh; width: auto; height: auto; background: var(--bg); border-radius: 8px; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  rect { fill: none; stroke: var(--vision-mark); stroke-width: 3; }
  .label { position: absolute; transform: translateY(-100%); background: var(--vision-mark); color: var(--on-vision-mark); font-size: 12px; line-height: 1.4; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
  .label.inside { transform: none; }
  .small { font-size: 13px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .muted { color: var(--muted); }
  .view { border: 0; padding: 0; margin: 0; display: flex; gap: 12px; align-items: center; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  /* The object list (issue #158), as cam-proxy's: a row per object, the picked one marked. */
  .objects { list-style: none; margin: 0; padding: 0; display: grid; font-size: 13px; }
  .objects button { width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 5px 8px; border: 0; border-left: 3px solid transparent; border-radius: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .objects button:hover { background: color-mix(in srgb, var(--vision-mark) 10%, transparent); }
  .objects button:focus-visible { outline: 2px solid var(--vision-mark); outline-offset: -2px; }
  .objects button.sel { background: color-mix(in srgb, var(--vision-mark) 20%, transparent); border-left-color: var(--vision-mark); }
  .objects .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .objects .score { font-variant-numeric: tabular-nums; }
  .nobox { font-size: 12px; font-style: italic; }
</style>
