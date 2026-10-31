<script lang="ts">
  // The camera login (migration P4, M §9.8): in cams-admin mode a camera's
  // password stays local. An account admin enters it here; where the
  // credentials file is read-only (the cluster's Secret), cams shows how to
  // add it there instead — never with the password that was typed.
  // A camera behind an up-to-date cam-proxy (spec 2026-10-30 §6.2): the
  // password goes straight to that proxy, which keeps it once the camera
  // accepts it; cams keeps nothing. Shown to admins in either config mode.
  import { apiFetch } from '../lib/api';
  import { isAdmin } from '../lib/session';
  import { cameraById, cameras, me } from '../lib/stores';

  // authFailed: the camera's current error is camera_auth_failed (Settings reads
  // it from the camera status): the saved password is wrong.
  // missing: the proxy has no password for the camera; embedded: inside the
  // offline box's dialog (no heading, the form open); onsaved: after a save.
  let { cameraId, authFailed = false, missing = false, embedded = false, onsaved }: { cameraId: string; authFailed?: boolean; missing?: boolean; embedded?: boolean; onsaved?: () => void } = $props();
  const camera = $derived($cameraById(cameraId));
  const viaProxy = $derived(!!camera?.throughProxy);
  let password = $state('');
  let status = $state('');
  let secret: { secretKey: string; user: string; unset: boolean } | null = $state(null);
  let saving = $state(false);
  let open = $state(false);
  let replaced = $state(false);
  const refused = $derived(authFailed && !replaced && !camera?.credentials);
  const needed = $derived(viaProxy ? embedded || ((authFailed || missing) && !replaced) : !!camera?.credentials || refused);
  const showForm = $derived(needed || open);

  // The proxy's answer, in words (never the password).
  function proxyAnswer(status: number, body: { error?: string; retryAfterS?: number } | null): string {
    if (status === 422) return 'The camera refused this password.';
    if (status === 503) return "The camera can't be reached.";
    if (status === 429) return `Too many tries; wait ${body?.retryAfterS ?? 60} s.`;
    if (status === 409 && body?.error === 'env_password') return 'This proxy has a password in its settings file; remove it there first.';
    if (status === 409 && (body?.error === 'not_trusted' || body?.error === 'fingerprint_changed')) return "The cam-proxy doesn't trust the camera's certificate: trust it first.";
    if (status === 403 && body?.error === 'proxy_admin_missing') return "cams has no admin token for this proxy: use the proxy's admin page.";
    return 'Could not save the password.';
  }

  async function save() {
    saving = true;
    status = '';
    secret = null;
    try {
      const res = await apiFetch(`/api/cameras/${encodeURIComponent(cameraId)}/credentials`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res.status === 204 && viaProxy) {
        status = 'Saved on the cam-proxy. It signs in to the camera with it now.';
        password = '';
        open = false;
        replaced = true;
        onsaved?.();
        return;
      }
      if (res.status === 204) {
        status = 'Saved. cams signs in to the camera with it now.';
        password = '';
        open = false;
        replaced = true;
        cameras.update((l) => l.map((c) => (c.id === cameraId ? { ...c, credentials: undefined } : c)));
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string; reason?: string; secretKey?: string; user?: string; retryAfterS?: number } | null;
      if (viaProxy) {
        password = '';
        status = proxyAnswer(res.status, body);
      } else if (res.status === 409 && body?.error === 'credentials_read_only' && body.secretKey) {
        secret = { secretKey: body.secretKey, user: body.user ?? '', unset: body.reason === 'unset' };
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

{#if camera && (viaProxy || $me?.configSource === 'cams-admin') && isAdmin($me)}
  <div class="login" class:card={!embedded} data-testid="camera-login">
    {#if !embedded}<h2>Camera login</h2>{/if}
    {#if showForm}
      <p class="muted">
        {#if viaProxy}
          {#if authFailed && !replaced}The camera refused the password its cam-proxy has.{:else if missing && !replaced}The cam-proxy has no password for this camera.{/if}
          Save the login for {camera.name} on its cam-proxy? cams keeps no copy.
        {:else if refused}
          The camera refused the saved password. Enter the right one.
        {:else if camera?.credentials}
          {camera.credentials === 'mismatch' ? 'The camera user here differs from cams-admin’s.' : camera.credentials === 'unconfirmed' ? 'This camera’s connection data waits for an admin’s Confirm (the banner above): no password goes to it before.' : 'cams has no password for this camera here.'}
        {:else}
          Enter the camera’s new password. It replaces the saved one.
        {/if}
        Camera passwords never come from cams-admin.
      </p>
      <form onsubmit={(e) => { e.preventDefault(); void save(); }}>
        <input type="password" autocomplete="new-password" data-testid="camera-password" maxlength="128" bind:value={password} aria-label="Camera password" />
        <button class="primary" type="submit" data-testid="camera-password-save" disabled={saving || !password}>Save</button>
        {#if open && !needed}<button type="button" class="ghost" onclick={() => { open = false; password = ''; }}>Cancel</button>{/if}
      </form>
    {:else}
      <div><button type="button" class="ghost" data-testid="camera-password-change" onclick={() => { open = true; status = ''; secret = null; }}>Change camera password</button></div>
    {/if}
    {#if status}<p class="muted" role="status" data-testid="camera-login-status">{status}</p>{/if}
    {#if secret}
      <div data-testid="camera-login-secret" class="secret">
        {#if secret.unset}
          <p>This cams has no credentials file, so a password can’t be saved here. Add this line to its <code>.env</code>, restart cams (<code>docker compose up -d</code>), then save again:</p>
          <pre>CAMERA_CREDENTIALS_FILE=/data/camera-credentials.json</pre>
        {:else}
          <p>The credentials file here is read-only. Add the password to the <code>cams-camera-credentials</code> Secret:</p>
          <pre>{`"${secret.secretKey}": { "user": "${secret.user}", "password": "<password>" }`}</pre>
        {/if}
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
  button.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  button:disabled { opacity: 0.5; cursor: default; }
  pre { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; color: var(--text); }
  .muted { color: var(--muted); margin: 0; }
</style>
