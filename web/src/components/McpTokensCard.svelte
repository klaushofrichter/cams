<script lang="ts">
  // Settings → Assistant access (MCP) (spec 2026-10-27-mcp-server-design §6):
  // every member makes and revokes their own read tokens; an account admin
  // also sees every token of the account and can revoke any. A new token is
  // shown once, with the line that adds it to Claude Code.
  import SettingsCard from './SettingsCard.svelte';
  import { getJson, postJson } from '../lib/api';
  import { claudeAddLine, DAY_CHOICES, issueError, tokenState, when, type McpToken, type McpTokenList } from '../lib/mcpTokens';

  let { admin }: { admin: boolean } = $props();

  let own = $state<McpToken[]>([]);
  let all = $state<McpToken[] | null>(null);
  let plainHttp = $state(false);
  let endpoint = $state('');
  let loadFailed = $state(false);
  let name = $state('');
  let days = $state<number>(30);
  let creating = $state(false);
  let createError = $state('');
  let fresh = $state<{ token: string; endpoint: string } | null>(null);
  let copied = $state(false);
  let confirming = $state<string | null>(null);

  async function load() {
    try {
      const mine = await getJson<McpTokenList>('/api/mcp-tokens');
      own = mine.items;
      plainHttp = mine.plainHttp;
      endpoint = mine.endpoint;
      all = admin ? (await getJson<McpTokenList>('/api/mcp-tokens?all=1')).items : null;
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
  }
  $effect(() => {
    void admin;
    void load();
  });

  async function create() {
    creating = true;
    createError = '';
    const r = await postJson<{ token?: string; endpoint?: string; error?: string; field?: string }>('/api/mcp-tokens', { name: name.trim(), days }).catch(() => null);
    creating = false;
    if (r?.status === 201 && r.body.token) {
      fresh = { token: r.body.token, endpoint: r.body.endpoint ?? endpoint };
      copied = false;
      name = '';
      await load();
    } else createError = issueError(r?.status ?? 0, r?.body.error ?? null, r?.body.field ?? null);
  }

  async function revoke(id: string) {
    confirming = null;
    await postJson(`/api/mcp-tokens/${encodeURIComponent(id)}/revoke`, {}).catch(() => null);
    await load();
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(claudeAddLine(fresh.endpoint, fresh.token));
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

{#snippet rows(list: McpToken[], showIssuer: boolean)}
  <ul class="tokens">
    {#each list as t (t.id)}
      <li data-testid="mcp-token-row" class:gone={t.state !== 'active'}>
        <div class="what">
          <strong>{t.name}</strong>
          {#if showIssuer}<span class="muted">{t.issuer}</span>{/if}
          <span class="muted">Created {when(t.createdAt)} · {tokenState(t)} · last used {when(t.lastUsedAt)}{t.callsToday ? ` · ${t.callsToday} calls today` : ''}</span>
        </div>
        {#if t.state === 'active'}
          {#if confirming === t.id}
            <span class="confirm">
              <button data-testid="mcp-revoke-cancel" onclick={() => (confirming = null)}>Cancel</button>
              <button class="danger" data-testid="mcp-revoke-confirm" onclick={() => revoke(t.id)}>Revoke</button>
            </span>
          {:else}
            <button data-testid="mcp-revoke" onclick={() => (confirming = t.id)}>Revoke…</button>
          {/if}
        {/if}
      </li>
    {:else}
      <li class="muted">No tokens.</li>
    {/each}
  </ul>
{/snippet}

<SettingsCard id="mcp" title="Assistant access (MCP)" description="Tokens that let an AI assistant (Claude Code, Claude Desktop) read this account's cameras, events, stills and archive, and make short clips. A token acts as you, in this account, and can change nothing.">
  {#if plainHttp}
    <p class="warn" role="note" data-testid="mcp-plain-http">This viewer runs over plain http: tokens and video links travel unencrypted on your network.</p>
  {/if}
  <p class="muted small">Pictures and video links go to the assistant's provider. A token works on this viewer only.</p>

  {#if fresh}
    <div class="fresh" data-testid="mcp-fresh">
      <p><strong>Your new token.</strong> It is shown only now: copy it.</p>
      <code data-testid="mcp-new-token">{fresh.token}</code>
      <p class="muted small">Add it to Claude Code:</p>
      <code class="line" data-testid="mcp-add-line">{claudeAddLine(fresh.endpoint, fresh.token)}</code>
      <div class="actions">
        <button data-testid="mcp-copy" onclick={copy}>{copied ? 'Copied' : 'Copy line'}</button>
        <button class="primary" data-testid="mcp-done" onclick={() => (fresh = null)}>Done</button>
      </div>
    </div>
  {/if}

  <h3>Your tokens</h3>
  {#if loadFailed}<p class="err" role="alert">The tokens could not be loaded.</p>{:else}{@render rows(own, false)}{/if}

  <form class="new" onsubmit={(e) => { e.preventDefault(); void create(); }}>
    <label>Name <input data-testid="mcp-name" maxlength="64" placeholder="e.g. laptop" bind:value={name} /></label>
    <label>Valid for
      <select data-testid="mcp-days" bind:value={days}>
        {#each DAY_CHOICES as d (d)}<option value={d}>{d} days</option>{/each}
      </select>
    </label>
    <button class="primary" type="submit" data-testid="mcp-create" disabled={creating || !name.trim()}>Create token</button>
  </form>
  {#if createError}<p class="err" role="alert" data-testid="mcp-create-error">{createError}</p>{/if}

  {#if admin && all}
    <div data-testid="mcp-all-tokens">
      <h3>All tokens of this account</h3>
      {@render rows(all, true)}
    </div>
  {/if}
</SettingsCard>

<style>
  h3 { margin: 4px 0 0; font-size: 14px; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; margin: 0; }
  .warn { margin: 0; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--text); font-size: 13px; }
  .err { color: var(--danger); font-size: 13px; margin: 0; }
  .tokens { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .tokens li { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .tokens li.gone { opacity: 0.6; }
  .what { display: grid; gap: 2px; min-width: 0; font-size: 13px; }
  .what strong { font-size: 14px; overflow-wrap: anywhere; }
  .confirm { display: inline-flex; gap: 6px; }
  .new { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
  .new label { display: grid; gap: 4px; font-size: 13px; }
  .fresh { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); }
  .fresh p { margin: 0; }
  code { overflow-wrap: anywhere; word-break: break-all; font-size: 12px; user-select: all; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  input, select { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
  button { font: inherit; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  button.danger { background: var(--danger); color: #fff; border-color: transparent; }
</style>
