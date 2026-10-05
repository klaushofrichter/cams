<script lang="ts">
  import { onDestroy, onMount, tick, type Snippet } from 'svelte';
  import { portal } from '../lib/portal';

  // A dialog over the page (the Archive's player, edit and confirm dialogs):
  // a backdrop, Escape and the ✕ close it, focus goes in on open, stays inside
  // with Tab and goes back where it was on close (like the Save dialog).
  let { title, testid, onclose, children, width = 460, closeLabel = 'Close' }: { title: string; testid: string; onclose: () => void; children: Snippet; width?: number; closeLabel?: string } = $props();

  let el: HTMLElement | undefined = $state();
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  const focusables = () => [...(el?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], video[tabindex]') ?? [])].filter((e) => !e.hasAttribute('disabled'));
  onMount(() => void tick().then(() => (focusables().find((f) => f.dataset.autofocus !== undefined) ?? focusables()[1] ?? focusables()[0])?.focus()));
  onDestroy(() => opener?.focus?.());
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1].focus();
  }
</script>

<div class="layer" use:portal>
  <div class="backdrop" role="presentation" onclick={onclose}></div>
  <div class="dialog" role="dialog" aria-modal="true" aria-label={title} data-testid={testid} tabindex="-1" bind:this={el} onkeydown={key} style={`--w: ${width}px`}>
    <header>
      <h2>{title}</h2>
      <button class="x" data-testid={`${testid}-close`} aria-label={closeLabel} onclick={onclose}>✕</button>
    </header>
    {@render children()}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: var(--scrim); z-index: 40; }
  .dialog {
    position: fixed; z-index: 41; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(var(--w), calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto;
    display: flex; flex-direction: column; gap: 12px; padding: 18px; border-radius: var(--radius);
    background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); color: var(--text);
  }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  h2 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
  .x { border: 0; background: transparent; color: var(--muted); font-size: 16px; cursor: pointer; }
</style>
