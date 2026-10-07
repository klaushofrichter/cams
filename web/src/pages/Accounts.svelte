<script lang="ts">
  // The account picker (migration P4, M §9.5, R4-13): after a Google
  // sign-in with several accounts, and from "Switch account" in the menu.
  import { onMount } from 'svelte';
  import { getJson } from '../lib/api';
  import { switchAccount, type AccountItem } from '../lib/session';

  let items: AccountItem[] = $state([]);
  let failed = $state(false);
  let busy = $state('');
  // The remembered account first (preselected), then the rest by name.
  const ordered = $derived([...items].sort((a, b) => Number(b.remembered) - Number(a.remembered) || a.displayName.localeCompare(b.displayName)));
  const preselected = $derived(ordered.find((i) => i.remembered)?.id ?? ordered.find((i) => i.current)?.id ?? ordered[0]?.id);

  onMount(() => {
    getJson<{ items: AccountItem[] }>('/api/accounts')
      .then((r) => (items = r.items))
      .catch(() => (failed = true));
  });

  async function choose(id: string) {
    busy = id;
    try {
      await switchAccount(id);
    } catch {
      failed = true;
      busy = '';
    }
  }
</script>

<section class="page" data-testid="accounts-page">
  <h1 data-testid="page-title">Choose an account</h1>
  {#if failed}
    <p class="card" role="alert" data-testid="accounts-error">Could not load your accounts. Please reload the page.</p>
  {:else}
    <ul class="list">
      {#each ordered as a (a.id)}
        <li>
          <button class="account" class:current={a.current} data-testid={`account-${a.id}`} aria-current={a.id === preselected ? 'true' : undefined}
            disabled={busy !== ''} onclick={() => choose(a.id)}>
            <span class="name">{a.displayName}</span>
            <span class="role" data-testid={`account-role-${a.id}`}>{a.role === 'admin' ? 'Admin' : 'Viewer'}</span>
            {#if a.current}<span class="tag">current</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; max-width: 520px; }
  .account {
    width: 100%; display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-radius: 14px;
    background: var(--surface); border: 1px solid var(--border); color: var(--text); font: inherit; text-align: left; cursor: pointer;
  }
  .account[aria-current='true'] { border-color: var(--accent); }
  .account:hover:not(:disabled) { background: var(--surface-2); }
  .name { flex: 1; font-weight: 600; font-size: 16px; }
  .role { color: var(--muted); font-size: 13px; }
  .tag { font-size: 12px; color: var(--accent); }
</style>
