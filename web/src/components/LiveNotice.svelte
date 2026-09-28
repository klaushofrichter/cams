<script lang="ts">
  import { onDestroy } from 'svelte';
  import { cameras } from '../lib/stores';
  import { liveEventsOn, preferences } from '../lib/preferences';
  import { eventStream, type CameraEvent } from '../lib/eventStream';
  import { TRIGGER_LABELS, type Trigger } from '../lib/recordings';

  // The live notification in the centre of the top bar (Klaus, 2026-09-28):
  // "Person on Den" for a second, then fading within 0.4 s. A new event
  // replaces it with a fresh timer; one at a time. Only the types chosen in
  // Settings, and only with live events on.
  let { source }: { source?: { onCameraEvent: (fn: (e: CameraEvent) => void) => () => void } } = $props();

  const SHOW_MS = 1000;
  const FADE_MS = 400;
  let text = $state<string | null>(null);
  let fading = $state(false);
  let t1: ReturnType<typeof setTimeout> | undefined;
  let t2: ReturnType<typeof setTimeout> | undefined;

  function show(e: CameraEvent) {
    const p = $preferences;
    if (p?.liveEvents === false) return;
    const types = p?.liveEventTypes ?? ['person', 'vehicle', 'pet', 'motion'];
    if (!(types as string[]).includes(e.kind)) return;
    const name = $cameras.find((c) => c.id === e.cam)?.name ?? e.cam;
    const kind = TRIGGER_LABELS[e.kind as Trigger] ?? e.kind.charAt(0).toUpperCase() + e.kind.slice(1);
    clearTimeout(t1);
    clearTimeout(t2);
    text = `${kind} on ${name}`;
    fading = false;
    t1 = setTimeout(() => (fading = true), SHOW_MS);
    t2 = setTimeout(() => (text = null), SHOW_MS + FADE_MS);
  }

  // The app's stream (or the test's); again when cameras or the setting change.
  $effect(() => {
    void $cameras;
    const on = $liveEventsOn;
    const s = source ?? (on ? eventStream() : undefined);
    return s?.onCameraEvent(show);
  });
  onDestroy(() => {
    clearTimeout(t1);
    clearTimeout(t2);
  });
</script>

{#if text}
  <div class="notice" class:fading data-testid="live-notice" role="status" aria-live="polite">{text}</div>
{/if}

<style>
  .notice {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 3;
    padding: 5px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap;
    max-width: 46vw; overflow: hidden; text-overflow: ellipsis;
    background: var(--accent); color: var(--accent-ink); box-shadow: var(--shadow);
    opacity: 1; transition: opacity 0.4s ease; pointer-events: none;
  }
  .notice.fading { opacity: 0; }
  /* On a phone the top bar is full: show it just below instead of over the picker. */
  @media (max-width: 640px) {
    .notice { top: calc(100% + 8px); transform: translateX(-50%); max-width: 80vw; }
  }
</style>
