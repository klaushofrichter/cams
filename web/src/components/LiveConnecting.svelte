<script lang="ts">
  import { preferences } from '../lib/preferences';
  import { keepAliveNote } from '../lib/liveUi';

  // Live's "connecting" indicator over the player (Klaus, 2026-10-03): shown
  // until the stream plays. Over the proxy's stills it is a compact pill at
  // the bottom, so the still stays visible; otherwise centred in the box.
  // `unavailable` (30 s without playing): a calm message without the spinner
  // or the keep-alive line; the retries go on.
  let { reconnecting = false, unavailable = false, stills = false }: { reconnecting?: boolean; unavailable?: boolean; stills?: boolean } = $props();
  const note = $derived(keepAliveNote($preferences?.liveKeepAlive ?? 60));
</script>

<div class="connecting" class:stills data-testid="live-connecting" data-state={unavailable ? 'unavailable' : 'connecting'} role="status" aria-live="polite">
  {#if unavailable}
    <span class="text"><span class="title">The live stream isn't available right now. Still trying…{stills ? ' Showing stills meanwhile.' : ''}</span></span>
  {:else}
    <span class="spinner" aria-hidden="true"></span>
    <span class="text">
      <span class="title">{reconnecting ? 'Reconnecting to the live stream…' : 'Connecting to the live stream…'}</span>
      <span class="note" data-testid="live-connecting-note">{note}</span>
    </span>
  {/if}
</div>

<style>
  .connecting {
    position: absolute; z-index: 3; left: 50%; top: 50%; transform: translate(-50%, -50%);
    display: flex; align-items: center; gap: 12px; box-sizing: border-box;
    width: max-content; max-width: calc(100% - 24px);
    padding: 10px 16px; border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 90%, transparent); color: var(--text); border: 1px solid var(--border); box-shadow: var(--shadow);
    pointer-events: none;
  }
  /* Over the stills: out of the way at the bottom, above the still's caption. */
  .connecting.stills { top: auto; bottom: var(--live-connecting-bottom, 12px); transform: translateX(-50%); padding: 6px 14px; }
  .text { display: grid; gap: 2px; min-width: 0; }
  .title { font-size: 14px; font-weight: 600; }
  [data-state='unavailable'] .title { font-weight: 500; }
  .note { font-size: 12px; color: var(--muted); }
  .stills .title { font-size: 13px; }
  .stills .note { font-size: 11px; }
  .spinner {
    flex: none; width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; border-color: var(--accent); opacity: 0.6; }
  }
  @media (max-width: 480px) {
    .connecting { border-radius: 14px; padding: 8px 12px; gap: 10px; }
    .title { font-size: 13px; }
    .note { font-size: 11px; }
  }
</style>
