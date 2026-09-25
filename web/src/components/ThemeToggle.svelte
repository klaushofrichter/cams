<script lang="ts">
  import Icon from './Icon.svelte';
  import { toggleTheme } from '../lib/theme';
  import { theme } from '../lib/stores';
</script>

<button
  class="icon-btn"
  data-testid="theme-toggle"
  onclick={() => theme.set(toggleTheme())}
  aria-label={$theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
  title={$theme === 'dark' ? 'Light theme' : 'Dark theme'}
>
  <Icon name={$theme === 'dark' ? 'sun' : 'moon'} />
</button>

<style>
  .icon-btn {
    width: 36px; height: 36px; display: grid; place-items: center;
    border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2);
    cursor: pointer; transition: background-color 0.15s ease, transform 0.15s ease;
  }
  .icon-btn:hover { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .icon-btn:active { transform: scale(0.95); }
</style>
