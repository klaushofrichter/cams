<script lang="ts">
  let { state, message = '' }: { state: 'idle' | 'saving' | 'saved' | 'partial' | 'error'; message?: string } = $props();
  const text = $derived(
    { idle: '', saving: 'Saving…', saved: 'Saved', partial: 'Some changes were not applied', error: message || 'Could not save' }[state],
  );
</script>

<span class="state" data-testid="save-state" data-state={state} class:ok={state === 'saved'} class:bad={state === 'error' || state === 'partial'} role="status" aria-live="polite">{text}</span>

<style>
  .state { font-size: 13px; color: var(--muted); min-height: 1em; transition: color 0.2s ease; }
  .ok { color: var(--accent); }
  .bad { color: var(--danger); }
</style>
