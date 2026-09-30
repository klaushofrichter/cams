<script lang="ts">
  import type { Box, StillObject, SummaryEntry } from '../lib/vision';

  // The Timeline's large still (spec 2026-09-30-analytics-in-cams-design): for
  // an analysed second, Vision's summary boxes with labels; "Show all objects"
  // draws everything Vision reported instead.
  let { src, alt, summary, loadAll }: { src: string; alt: string; summary: SummaryEntry[] | null; loadAll?: () => Promise<StillObject[]> } = $props();

  let showAll = $state(false);
  let all = $state<StillObject[] | null>(null);
  let failed = $state(false);

  // An object without coordinates arrives as a zero-area box, or none: not drawn.
  const drawn = (b: Box | null | undefined): Box | null => (b && b.x1 > b.x0 && b.y1 > b.y0 ? b : null);
  const boxes = $derived<{ label: string; box: Box }[]>(
    showAll && all
      ? all.flatMap((o) => {
          const b = drawn(o.box);
          return b ? [{ label: `${o.name} ${o.score.toFixed(2)}`, box: b }] : [];
        })
      : (summary ?? []).flatMap((e) => {
          const b = drawn(e.box);
          return b ? [{ label: `${e.subtype} ${e.score.toFixed(2)}`, box: b }] : [];
        }),
  );

  // Another still: back to its summary.
  $effect(() => {
    void src;
    showAll = false;
    all = null;
    failed = false;
  });

  async function toggle() {
    showAll = !showAll;
    if (!showAll || all || !loadAll) return;
    try {
      all = await loadAll();
    } catch {
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
      {#each boxes as b, i (i)}<span class="label" data-testid="timeline-box-label" style={`left:${b.box.x0 * 100}%;top:${b.box.y0 * 100}%`}>{b.label}</span>{/each}
    {/if}
  </div>
  {#if summary && loadAll}
    <label class="small"><input type="checkbox" checked={showAll} onchange={() => void toggle()} data-testid="timeline-show-all" /> Show all objects</label>
    {#if failed}<span class="muted small">Could not load all objects.</span>{/if}
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
  rect { fill: none; stroke: #a855f7; stroke-width: 3; }
  .label { position: absolute; transform: translateY(-100%); background: #a855f7; color: #fff; font-size: 12px; line-height: 1.4; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
  .small { font-size: 13px; }
  .muted { color: var(--muted); }
</style>
