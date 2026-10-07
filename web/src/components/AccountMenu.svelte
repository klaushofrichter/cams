<script lang="ts">
  // The account in the top bar (migration P4, M §9.5): its name, and
  // "Switch account" for a person in several accounts.
  import { me } from '../lib/stores';
  // In the phone drawer its own test ids (the top bar's copy is hidden there).
  let { drawer = false }: { drawer?: boolean } = $props();
  const id = (name: string) => (drawer ? `drawer-${name}` : name);
</script>

{#if $me?.account}
  <span class="account" class:drawer data-testid={id('account-menu')}>
    <span class="name" data-testid={id('account-name')} title={$me.role === 'viewer' ? 'Viewer' : 'Admin'}>{$me.account.displayName}</span>
    {#if ($me.accounts ?? 1) > 1}
      <a class="switch" data-testid={id('switch-account')} href="/app/accounts">Switch account</a>
    {/if}
  </span>
{/if}

<style>
  .account { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
  .name { color: var(--text); font-weight: 600; max-width: 16ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .switch { color: var(--accent); text-decoration: none; white-space: nowrap; }
  .switch:hover { text-decoration: underline; }
  .account.drawer { flex-direction: column; align-items: flex-start; padding: 8px 12px; gap: 4px; }
</style>
