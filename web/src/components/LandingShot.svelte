<script lang="ts">
  // One framed screenshot on the landing page. The files under /landing/ are
  // not in git until reviewed, so a shot that fails to load removes itself
  // (and tells its parent through `failed`).
  import type { Shot } from '../lib/landingContent';

  let { shot, frame = 'browser', failed = $bindable(false) }: { shot: Shot; frame?: 'browser' | 'phone' | 'plain'; failed?: boolean } = $props();
</script>

{#if !failed}
  <figure class="shot {frame}" data-testid="shot">
    {#if frame === 'browser'}<span class="bar" aria-hidden="true"><i></i><i></i><i></i></span>{/if}
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
  .plain { border-radius: 12px; }
</style>
