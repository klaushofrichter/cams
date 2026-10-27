<script lang="ts">
  // The Pi's e-paper display in its frame, cycling its pages every 2 s like
  // the real panel: a hard switch with a short black-and-white refresh flash,
  // no fade. Under reduced motion the pages stand side by side, still. When
  // the first page's file is missing, the display is left out.
  import type { Shot } from '../lib/landingContent';

  let { pages }: { pages: (Shot & { name: string })[] } = $props();
  let failed = $state(false);
</script>

{#if !failed}
  <figure class="device" data-testid="epaper-cycle">
    <span class="keys" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <div class="screen" style="--n: {pages.length}">
      {#each pages as page, i (page.src)}
        <img
          data-testid="epaper-page"
          src={page.src}
          alt={page.alt}
          width={page.width}
          height={page.height}
          loading="lazy"
          decoding="async"
          style="animation-delay: {i * 2}s"
          onerror={() => {
            if (i === 0) failed = true;
          }}
        />
      {/each}
      <span class="flash" data-testid="epaper-flash" aria-hidden="true"></span>
    </div>
    <figcaption>{pages.map((p) => p.name).join(' · ')}</figcaption>
  </figure>
{/if}

<style>
  .device {
    margin: 0;
    max-width: 560px;
    display: grid;
    grid-template-columns: 18px 1fr;
    column-gap: 14px;
    align-items: center;
    padding: 16px 18px 12px 14px;
    border-radius: 12px;
    background: var(--chrome);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .keys { display: grid; gap: 16px; }
  .keys i { display: block; width: 18px; height: 10px; border-radius: 3px; background: var(--surface-2); border: 1px solid var(--border); }
  .screen { position: relative; display: grid; border: 2px solid var(--border); border-radius: 2px; overflow: hidden; }
  img { grid-area: 1 / 1; display: block; width: 100%; height: auto; opacity: 0; animation: page 8s steps(1, end) infinite; }
  .flash { grid-area: 1 / 1; pointer-events: none; opacity: 0; animation: flash 2s steps(1, end) infinite; }
  figcaption { grid-column: 2; margin-top: 8px; font-size: 12px; color: var(--muted); text-align: center; letter-spacing: 0.06em; }
  /* Each page shows for its quarter of the 8 s cycle. */
  @keyframes page { 0% { opacity: 1; } 25%, 100% { opacity: 0; } }
  /* The refresh at each switch: black, then white, then the new page. */
  @keyframes flash {
    0% { opacity: 1; background: var(--player-bg); }
    3% { opacity: 1; background: var(--on-grad); }
    6%, 100% { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .device { max-width: none; }
    .screen { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; border: 0; }
    img { grid-area: auto; opacity: 1; animation: none; border: 2px solid var(--border); }
    .flash { display: none; animation: none; }
  }
</style>
