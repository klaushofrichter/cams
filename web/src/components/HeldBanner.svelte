<script lang="ts">
  // Held connection changes (migration P4, M §9.7): cams-admin changed where
  // cams connects for a camera or its proxy; cams keeps the old values until
  // an account admin confirms here (or keeps the old ones).
  import { apiFetch, getJson } from '../lib/api';
  import { isAdmin } from '../lib/session';
  import { me } from '../lib/stores';

  interface Held { camsId: string; fields: string[]; from: Record<string, unknown>; to: Record<string, unknown>; keptOld: boolean }
  const LABELS: Record<string, string> = { proxyUrl: 'proxy address', caFingerprints: 'proxy CA', proxyTlsServername: 'proxy TLS name', host: 'camera address', protocol: 'protocol', tlsServername: 'camera TLS name' };
  let items: Held[] = $state([]);
  let busy = $state(false);
  const shown = $derived(items.filter((i) => !i.keptOld));
  const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === null || v === undefined ? 'none' : String(v));

  async function load() {
    try {
      items = (await getJson<{ items: Held[] }>('/api/admin/held')).items;
    } catch {
      items = [];
    }
  }
  $effect(() => {
    if (isAdmin($me) && ($me?.held ?? 0) > 0) void load();
    else items = [];
  });

  async function act(action: 'confirm' | 'keep', camsId: string) {
    busy = true;
    try {
      await apiFetch(`/api/admin/held/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camsIds: [camsId] }) });
      await load();
    } finally {
      busy = false;
    }
  }
</script>

{#if shown.length}
  <div class="banner" role="alert" data-testid="held-banner">
    <strong>cams-admin changed where cams connects.</strong> cams keeps the old values until you confirm.
    <ul>
      {#each shown as h (h.camsId)}
        <li data-testid={`held-${h.camsId}`}>
          <span class="cam">{h.camsId}</span>
          {#each h.fields as f (f)}
            <span class="change">{LABELS[f] ?? f}: <code>{show(h.from[f])}</code> → <code>{show(h.to[f])}</code></span>
          {/each}
          <span class="actions">
            <button class="primary" data-testid={`held-confirm-${h.camsId}`} disabled={busy} onclick={() => act('confirm', h.camsId)}>Confirm</button>
            <button data-testid={`held-keep-${h.camsId}`} disabled={busy} onclick={() => act('keep', h.camsId)}>Keep old</button>
          </span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .banner { margin-bottom: 16px; padding: 12px 16px; border-radius: 12px; background: color-mix(in srgb, var(--warning) 16%, transparent); border: 1px solid var(--warning); color: var(--text); font-size: 14px; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }
  li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .cam { font-weight: 600; }
  code { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
  .actions { display: inline-flex; gap: 8px; margin-left: auto; }
  button { font: inherit; padding: 4px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
</style>
