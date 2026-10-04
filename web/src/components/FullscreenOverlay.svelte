<!-- web/src/components/FullscreenOverlay.svelte -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { focusBeforeFullscreen, fsKey, hintFor, type FsAction } from '../lib/playerFullscreen';
  import { classifyStroke, gestureAction } from '../lib/gestures';
  import type { Mode } from '../lib/videoMode';

  // The player's controls in fullscreen (#182, spec
  // 2026-10-04-fullscreen-recorded): a bar that hides 3 s after the last
  // input, the keys, the phone gestures and a short hint. Mounted only while
  // the player is fullscreen; the player does what `onaction` asks and says
  // whether it did anything (nothing after now in live).
  let { mode, playing, kind, canPlay = true, canPrev = true, canNext = true, onaction, onlive, onexit }: {
    mode: Mode;
    playing: boolean;
    kind: 'element' | 'fill';
    canPlay?: boolean; // false: "Later than now", nothing to play
    canPrev?: boolean; // false: at the first (shown) event
    canNext?: boolean; // false: at the last (shown) event
    onaction: (a: FsAction) => boolean;
    onlive: () => void;
    onexit: () => void;
  } = $props();

  const HIDE_MS = 3000;
  const HINT_MS = 700;
  const live = $derived(mode === 'live');

  let shown = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  function show() {
    shown = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (shown = false), HIDE_MS);
  }
  show();

  // The focus comes along (it was on the sidebar's Fullscreen button, where
  // Space would press that button instead of playing), and goes back there
  // on leaving. Meanwhile everything outside the player box is inert: Tab
  // stays inside, and no other key handler (the strip's ←/→) runs as well
  // (review of #185). Elements already inert stay so.
  let root: HTMLDivElement | undefined = $state();
  let madeInert: Element[] = [];
  onMount(() => {
    const before = focusBeforeFullscreen() ?? document.activeElement;
    const box = root?.parentElement;
    for (let el: Element | null | undefined = box; el && el !== document.documentElement; el = el.parentElement) {
      for (const sib of el.parentElement?.children ?? []) {
        if (sib === el || sib.hasAttribute('inert') || sib instanceof HTMLScriptElement) continue;
        sib.setAttribute('inert', '');
        madeInert.push(sib);
      }
    }
    root?.focus({ preventScroll: true });
    return () => {
      for (const el of madeInert) el.removeAttribute('inert');
      madeInert = [];
      if (before instanceof HTMLElement && before.isConnected && document.activeElement !== before) before.focus({ preventScroll: true });
    };
  });

  let hint = $state('');
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => {
    clearTimeout(hideTimer);
    clearTimeout(hintTimer);
  });

  function act(a: FsAction) {
    show();
    if (a.kind === 'exit') return onexit();
    const before = playing;
    if (!onaction(a)) return;
    hint = hintFor(a, a.kind === 'toggle' ? !before : before); // only once it did something (an event jump at the last: nothing)
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (hint = ''), HINT_MS);
  }

  // Keys on the window: the focus is often still on the sidebar's
  // Fullscreen button, outside the box. Space is always play/pause (as in
  // video players), also on a focused button; Enter presses the button.
  function keydown(e: KeyboardEvent) {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    // Aimed at something outside the player box (not one of its ancestors,
    // such as the player itself): that element's own handler has it.
    const box = root?.parentElement;
    if (t instanceof Element && box && !box.contains(t) && !t.contains(box)) return;
    // Tab goes round inside the player (not out to the browser's bar).
    if (e.key === 'Tab' && box && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const all = [...box.querySelectorAll<HTMLElement>('button, a[href], [tabindex]')].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
      if (!all.length) return;
      const i = all.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey ? i <= 0 : i === -1 || i === all.length - 1) {
        e.preventDefault();
        all[e.shiftKey ? all.length - 1 : 0].focus();
      }
      return;
    }
    const a = fsKey(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    act(a);
  }

  // One stroke per pointer: start on down, classify on up.
  let start: { id: number; x: number; y: number; t: number } | null = null;
  let layer: HTMLDivElement | undefined = $state();
  function down(e: PointerEvent) {
    if (!e.isPrimary) return;
    start = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
  }
  function up(e: PointerEvent) {
    const s = start;
    start = null;
    if (!s || s.id !== e.pointerId || !layer) return;
    const r = layer.getBoundingClientRect();
    const g = classifyStroke({ x0: s.x, y0: s.y, x1: e.clientX, y1: e.clientY, ms: Date.now() - s.t, boxLeft: r.left, boxWidth: r.width, viewWidth: window.innerWidth });
    if (!g) return;
    if (e.pointerType === 'mouse') {
      // Desktop: a click on the picture plays or pauses (the thirds are for touch).
      if (g.kind === 'tap' && !live) act({ kind: 'toggle' });
      else show();
      return;
    }
    const wasHidden = !shown;
    show();
    // Live: the picture only shows the controls (a stray tap mustn't leave live);
    // hidden: the first tap only shows them (a stray tap mustn't jump 10 s).
    if (live || (g.kind === 'tap' && wasHidden)) return;
    act(gestureAction(g));
  }
  function move(e: PointerEvent) {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') show();
  }
</script>

<svelte:window onkeydown={keydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fs" class:hidden={!shown} bind:this={root} tabindex="-1" data-testid="fs-overlay" data-shown={shown} data-kind={kind} onpointermove={move}>
  <div class="gestures" data-testid="fs-gestures" bind:this={layer} onpointerdown={down} onpointerup={up} onpointercancel={() => (start = null)}></div>
  <!-- Always mounted (only its text changes), so screen readers announce each hint. -->
  <div class="hint" class:on={hint !== ''} data-testid="fs-hint" role="status">{hint}</div>
  <div class="bar" data-testid="fs-bar" aria-hidden={!shown}>
    <button data-testid="fs-prev-event" title="Previous event" aria-label="Previous event" tabindex={shown ? 0 : -1} disabled={!canPrev} onclick={() => act({ kind: 'event', dir: -1 })}><Icon name="prev" size={18} /></button>
    <button data-testid="fs-back-10" title="Back 10 seconds" aria-label="Back 10 seconds" tabindex={shown ? 0 : -1} onclick={() => act({ kind: 'skip', ms: -10_000 })}><Icon name="back10" size={18} /></button>
    <button data-testid="fs-back-1" title="Back 1 second" aria-label="Back 1 second" tabindex={shown ? 0 : -1} onclick={() => act({ kind: 'skip', ms: -1000 })}><Icon name="back1" size={18} /></button>
    <button data-testid="fs-play" class="primary" aria-pressed={playing} title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'} tabindex={shown ? 0 : -1}
      disabled={live || !canPlay} onclick={() => act({ kind: 'toggle' })}><Icon name={playing ? 'pause' : 'play'} size={18} /></button>
    <button data-testid="fs-fwd-1" title="Forward 1 second" aria-label="Forward 1 second" tabindex={shown ? 0 : -1} disabled={live} onclick={() => act({ kind: 'skip', ms: 1000 })}><Icon name="fwd1" size={18} /></button>
    <button data-testid="fs-fwd-10" title="Forward 10 seconds" aria-label="Forward 10 seconds" tabindex={shown ? 0 : -1} disabled={live} onclick={() => act({ kind: 'skip', ms: 10_000 })}><Icon name="fwd10" size={18} /></button>
    <button data-testid="fs-next-event" title="Next event" aria-label="Next event" tabindex={shown ? 0 : -1} disabled={live || !canNext} onclick={() => act({ kind: 'event', dir: 1 })}><Icon name="next" size={18} /></button>
    <span class="gap"></span>
    <button data-testid="fs-live" title="Back to live" aria-label="Back to live" tabindex={shown ? 0 : -1} disabled={live} onclick={() => { show(); onlive(); }}>⇥<span class="word">&nbsp;Live</span></button>
    <button data-testid="fs-exit" title="Leave fullscreen (Esc)" aria-label="Leave fullscreen" tabindex={shown ? 0 : -1} onclick={() => act({ kind: 'exit' })}><Icon name="shrink" size={18} /></button>
  </div>
</div>

<style>
  .fs { position: absolute; inset: 0; z-index: 3; outline: none; }
  .fs.hidden { cursor: none; }
  /* Taps and swipes are ours: no scrolling, no double-tap zoom. */
  .gestures { position: absolute; inset: 0; touch-action: none; }
  .hint {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none;
    padding: 10px 18px; border-radius: 12px; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums;
    background: var(--player-scrim); color: var(--on-grad);
  }
  .hint:not(.on) { opacity: 0; }
  /* Centred at the bottom, as wide as its buttons (one row down to a phone
     in portrait), clear of the safe areas. */
  .bar {
    position: absolute; width: fit-content; margin-inline: auto;
    left: calc(12px + env(safe-area-inset-left, 0px)); right: calc(12px + env(safe-area-inset-right, 0px));
    bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: center;
    padding: 8px; border-radius: 14px; background: var(--player-scrim);
    transition: opacity 0.25s;
  }
  .hidden .bar { opacity: 0; pointer-events: none; }
  .bar button {
    display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 40px; height: 40px; padding: 0 10px;
    border-radius: 10px; border: 1px solid color-mix(in srgb, var(--on-grad) 25%, transparent); background: transparent;
    color: var(--on-grad); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .bar button:hover:not(:disabled) { background: color-mix(in srgb, var(--on-grad) 15%, transparent); }
  .bar button.primary { background: var(--grad); border: none; }
  .bar button:disabled { opacity: 0.4; cursor: default; }
  .gap { width: 6px; }
  @media (max-width: 520px) {
    .bar { gap: 4px; padding: 6px; }
    .bar button { min-width: 34px; height: 38px; padding: 0 6px; }
    .gap, .word { display: none; }
  }
</style>
