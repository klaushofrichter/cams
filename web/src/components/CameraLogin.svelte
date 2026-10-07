<script lang="ts">
  // The camera login (migration P4, M §9.8): in cams-admin mode a camera's
  // password stays local. An account admin enters it here; where the
  // credentials file is read-only (the cluster's Secret), cams shows how to
  // add it there instead — never with the password that was typed.
  import { apiFetch } from '../lib/api';
  import { isAdmin } from '../lib/session';
  import { cameraById, cameras, me } from '../lib/stores';

  let { cameraId }: { cameraId: string } = $props();
  const camera = $derived($cameraById(cameraId));
  let password = $state('');
  let status = $state('');
  let secret: { secretKey: string; user: string } | null = $state(null);
  let saving = $state(false);

  async function save() {
    saving = true;
    status = '';
    secret = null;
    try {
      const res = await apiFetch(`/api/cameras/${encodeURIComponent(cameraId)}/credentials`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res.status === 204) {
        status = 'Saved. cams signs in to the camera with it now.';
        password = '';
        cameras.update((l) => l.map((c) => (c.id === cameraId ? { ...c, credentials: undefined } : c)));
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string; secretKey?: string; user?: string } | null;
      if (res.status === 409 && body?.error === 'credentials_read_only' && body.secretKey) {
        secret = { secretKey: body.secretKey, user: body.user ?? '' };
        password = '';
        status = '';
      } else status = 'Could not save the password.';
    } catch {
      status = 'Could not save the password.';
    } finally {
      saving = false;
    }
  }
</script>

{#if (camera?.credentials || status) && isAdmin($me)}
  <div class="login card" data-testid="camera-login">
    <h2>Camera login</h2>
    <p class="muted">
      {camera?.credentials === 'mismatch' ? 'The camera user here differs from cams-admin’s.' : 'cams has no password for this camera here.'}
      Camera passwords never come from cams-admin.
    </p>
    <form onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <input type="password" autocomplete="new-password" data-testid="camera-password" maxlength="128" bind:value={password} aria-label="Camera password" />
      <button class="primary" type="submit" data-testid="camera-password-save" disabled={saving || !password}>Save</button>
    </form>
    {#if status}<p class="muted" role="status" data-testid="camera-login-status">{status}</p>{/if}
    {#if secret}
      <div data-testid="camera-login-secret" class="secret">
        <p>The credentials file here is read-only. Add the password to the <code>cams-camera-credentials</code> Secret:</p>
        <pre>{`"${secret.secretKey}": { "user": "${secret.user}", "password": "<password>" }`}</pre>
      </div>
    {/if}
  </div>
{/if}

<style>
  .login { display: grid; gap: 10px; }
  h2 { margin: 0; font-size: 16px; color: var(--text); }
  form { display: flex; gap: 8px; flex-wrap: wrap; }
  input { flex: 1; min-width: 12ch; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  pre { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; color: var(--text); }
  .muted { color: var(--muted); margin: 0; }
</style>
