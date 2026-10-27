<script lang="ts">
  // One framed screenshot on the landing page. A shot whose file fails to
  // load removes itself (and tells its parent through `failed`), so the page
  // works while the files under /landing/ are missing.
  import type { Shot } from '../lib/landingContent';

  let { shot, frame = shot.frame ?? 'browser', failed = $bindable(false) }: { shot: Shot; frame?: 'browser' | 'phone' | 'epaper'; failed?: boolean } = $props();
</script>

{#if !failed}
  <figure class="shot {frame}" data-testid="shot">
    {#if frame === 'browser'}<span class="bar" aria-hidden="true"><i></i><i></i><i></i></span>{/if}
    {#if frame === 'epaper'}<span class="keys" aria-hidden="true"><i></i><i></i><i></i><i></i></span>{/if}
    <img src={shot.src} alt={shot.alt} width={shot.width} height={shot.height} loading="lazy" decoding="async" onerror={() => (failed = true)} />
  </figure>
{/if}

<style>
  .shot { margin: 0; overflow: hidden; background: var(--surface-2); border: 1px solid var(--border); box-shadow: var(--shadow); }
  img { display: block; width: 100%; height: auto; }
  .browser { border-radius: 12px; }
  .bar { display: flex; gap: 6px; padding: 9px 12px; background: var(--chrome); border-bottom: 1px solid var(--border); }
  .bar i { width: 9px; height: 9px; border-radius: 50%; background: var(--border); }
  .phone { border-radius: 26px; border: 6px solid var(--chrome); outline: 1px solid var(--border); }
  /* The Waveshare HAT: a dark board, the four keys on the left, the panel's
     pixels drawn 3× and scaled down smoothly. */
  .epaper {
    display: grid;
    grid-template-columns: 18px 1fr;
    gap: 12px;
    align-items: center;
    padding: 14px 16px 14px 12px;
    border-radius: 10px;
    background: var(--chrome);
  }
  .keys { display: grid; gap: 14px; }
  .keys i { display: block; width: 18px; height: 10px; border-radius: 3px; background: var(--surface-2); border: 1px solid var(--border); }
  .epaper img { border: 2px solid var(--border); border-radius: 2px; }
</style>
