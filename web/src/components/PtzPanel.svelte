<script lang="ts">
  import Icon from './Icon.svelte';
  import { persistedBoolean } from '../lib/stores';
  import { reveal } from '../lib/motion';
  import { ptzApi, ptzErrorText, type Direction, type PtzCapabilities } from '../lib/ptz';
  import { createHold, type Hold } from '../lib/ptzHold';

  // The PTZ panel (cam-proxy spec 2026-10-30-ptz-capabilities-design §8.2):
  // on the Video page for a pan/tilt camera, live only. Collapsed until
  // opened (remembered per browser). A tap on the pad is one short step, a
  // hold keeps moving until let go; whatever ends a hold (leaving the button,
  // the tab hidden, the window losing focus, another camera, the page going
  // away) stops the camera it moved.
  let { cameraId, ptz }: { cameraId: string; ptz: PtzCapabilities } = $props();

  const open = persistedBoolean('cams-ptz-open', false);
  let error = $state('');

  // The pad, row by row; null: the empty centre. The arrow icon points right
  // and is turned to each direction.
  const PAD: (Direction | null)[] = ['left-up', 'up', 'right-up', 'left', null, 'right', 'left-down', 'down', 'right-down'];
  const TURN: Record<Direction, number> = { right: 0, 'right-down': 45, down: 90, 'left-down': 135, left: 180, 'left-up': 225, up: 270, 'right-up': 315 };
  const label = (d: Direction) => `Move ${d.split('-').reverse().join('-')}`;

  type Key = `dir-${Direction}` | 'zoom-in' | 'zoom-out' | 'focus-near' | 'focus-far';
  // One Hold per button, for the camera shown; replaced (and every running
  // hold stopped, on its own camera) when the camera changes or the panel goes.
  let holds = new Map<Key, Hold>();
  $effect(() => {
    const cam = cameraId;
    const api = ptzApi(cam);
    const mine = () => cam === cameraId;
    const make = (start: (ms: number) => Promise<void>) =>
      createHold({
        start: (ms) => start(ms).then(() => { if (mine()) error = ''; }),
        stop: api.stop,
        onError: (e) => { if (mine()) error = ptzErrorText(e); },
      });
    const next = new Map<Key, Hold>();
    for (const d of PAD) if (d) next.set(`dir-${d}`, make((ms) => api.move(d, ms)));
    next.set('zoom-in', make((ms) => api.zoom('in', ms)));
    next.set('zoom-out', make((ms) => api.zoom('out', ms)));
    next.set('focus-near', make((ms) => api.focus('near', ms)));
    next.set('focus-far', make((ms) => api.focus('far', ms)));
    holds = next;
    error = '';
    return () => {
      for (const h of next.values()) h.cancel();
    };
  });

  const cancelAll = () => {
    for (const h of holds.values()) h.cancel();
  };
  $effect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') cancelAll();
    };
    window.addEventListener('blur', cancelAll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', cancelAll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  // Pointer and keyboard on one button.
  function press(key: Key) {
    return {
      onpointerdown: (e: PointerEvent) => {
        if (e.button !== 0) return;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        } catch {
          // no capture (an old browser, a synthetic event): pointerleave ends it
        }
        holds.get(key)?.press();
      },
      onpointerup: () => holds.get(key)?.release(),
      onpointerleave: () => holds.get(key)?.cancel(),
      onpointercancel: () => holds.get(key)?.cancel(),
      onlostpointercapture: () => holds.get(key)?.cancel(),
      onblur: () => holds.get(key)?.cancel(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!e.repeat) holds.get(key)?.press();
      },
      onkeyup: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') holds.get(key)?.release();
      },
      oncontextmenu: (e: Event) => e.preventDefault(),
    };
  }
</script>

<section class="tile ptz" data-testid="ptz-panel">
  <button class="head" data-testid="ptz-toggle" aria-expanded={$open} aria-controls="ptz-body" onclick={() => open.set(!$open)}>
    <span class="title">Pan &amp; tilt</span>
    <span class="chev" class:open={$open}><Icon name="chevron" size={16} /></span>
  </button>
  {#if $open}
    <div class="body" id="ptz-body" data-testid="ptz-body" transition:reveal>
      <div class="controls">
        {#if ptz.move}
          <div class="pad" role="group" aria-label="Direction">
            {#each PAD as d, i (d ?? `centre-${i}`)}
              {#if d}
                <button class="key" data-testid={`ptz-dir-${d}`} aria-label={label(d)} title={label(d)} style:--rot={`${TURN[d]}deg`} {...press(`dir-${d}`)}>
                  <span class="arrow"><Icon name="arrow" size={18} /></span>
                </button>
              {:else}
                <span class="centre" aria-hidden="true"></span>
              {/if}
            {/each}
          </div>
        {/if}
        {#if ptz.zoom || ptz.focus}
          <div class="lens">
            {#if ptz.zoom}
              <div class="row" role="group" aria-label="Zoom">
                <span class="what">Zoom</span>
                <button class="key" data-testid="ptz-zoom-out" aria-label="Zoom out" title="Zoom out" {...press('zoom-out')}>−</button>
                <button class="key" data-testid="ptz-zoom-in" aria-label="Zoom in" title="Zoom in" {...press('zoom-in')}>+</button>
              </div>
            {/if}
            {#if ptz.focus}
              <div class="row" role="group" aria-label="Focus">
                <span class="what">Focus</span>
                <button class="key" data-testid="ptz-focus-near" aria-label="Focus nearer" title="Focus nearer" {...press('focus-near')}>−</button>
                <button class="key" data-testid="ptz-focus-far" aria-label="Focus farther" title="Focus farther" {...press('focus-far')}>+</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
      <!-- Saved positions (Task 6) go here. -->
      {#if error}
        <p class="error" data-testid="ptz-error" role="alert" transition:reveal={{ duration: 120 }}>{error}</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; }
  .head {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 0; border: 0; background: none;
    color: var(--text); font: inherit; cursor: pointer; text-align: left;
  }
  .title { font-size: 13px; font-weight: 600; color: var(--muted); }
  .head:hover .title { color: var(--text); }
  .chev { margin-left: auto; display: inline-flex; color: var(--muted); transform: rotate(180deg); transition: transform 160ms ease; }
  .chev.open { transform: rotate(-90deg); }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
  .body { padding-top: 10px; }
  .controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .pad { display: grid; grid-template-columns: repeat(3, 40px); grid-auto-rows: 40px; gap: 6px; }
  .key {
    display: inline-flex; align-items: center; justify-content: center; min-width: 40px; height: 40px; padding: 0;
    border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
    font: inherit; font-size: 18px; line-height: 1; cursor: pointer;
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .key:hover { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .key:active { background: color-mix(in srgb, var(--accent) 26%, var(--surface-2)); border-color: var(--accent); }
  .key:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .arrow { display: inline-flex; transform: rotate(var(--rot)); }
  .centre { width: 40px; height: 40px; border-radius: 50%; border: 1px dashed var(--border); opacity: 0.6; }
  .lens { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .what { width: 44px; font-size: 13px; color: var(--muted); }
  .error { margin: 10px 0 0; font-size: 13px; color: var(--danger); }
</style>
