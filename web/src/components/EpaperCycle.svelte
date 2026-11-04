<script lang="ts">
  // The Pi's e-paper display in its frame, showing its pages 2 s each with a
  // soft crossfade (Klaus, 2026-10-27), on white paper so nothing dark ever
  // shows between pages. A timer moves to the next page and CSS transitions do
  // the fade, so when the timer stops (off screen or idle, #327) the running
  // fade still finishes: the display always rests on one whole page. Under
  // reduced motion the pages stand side by side, still. When the first page's
  // file is missing, the display is left out.
  import type { Shot } from '../lib/landingContent';
  import { runWhileUseful } from '../lib/landingAnimations';

  const PAGE_MS = 2700; // 0.7 s fading in over the outgoing page, then held 2 s.

  let { pages }: { pages: (Shot & { name: string })[] } = $props();
  let failed = $state(false);
  let current = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  function cycle(running: boolean) {
    clearInterval(timer);
    if (running) timer = setInterval(() => (current = (current + 1) % pages.length), PAGE_MS);
  }
</script>

{#if !failed}
  <figure class="device" data-testid="epaper-cycle">
    <span class="keys" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <div class="screen" data-testid="epaper-screen" use:runWhileUseful={cycle}>
      {#each pages as page, i (page.src)}
        <img
          data-testid="epaper-page"
          src={page.src}
          alt={page.alt}
          width={page.width}
          height={page.height}
          loading="lazy"
          decoding="async"
          class:on={i === current}
          onerror={() => {
            if (i === 0) failed = true;
          }}
        />
      {/each}
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
  .screen { position: relative; display: grid; border: 2px solid var(--border); border-radius: 2px; overflow: hidden; background: var(--epaper-paper); }
  img { grid-area: 1 / 1; display: block; width: 100%; height: auto; opacity: 0; transition: opacity 0.7s ease-in-out; }
  img.on { opacity: 1; }
  figcaption { grid-column: 2; margin-top: 8px; font-size: 12px; color: var(--muted); text-align: center; letter-spacing: 0.06em; }
  @media (prefers-reduced-motion: reduce) {
    .device { max-width: none; }
    .screen { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; border: 0; }
    img { grid-area: auto; opacity: 1; transition: none; border: 2px solid var(--border); }
  }
</style>
