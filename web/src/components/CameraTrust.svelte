<script lang="ts">
  // "Trust this camera's certificate" for a camera behind a cam-proxy (spec
  // 2026-10-30-camera-onboarding-design §6.2, §10.2): the fingerprint is the
  // one the proxy measured on the LAN (from its status), never typed. cams
  // pins it on the proxy with its proxy-admin token; a certificate that
  // changed meanwhile comes back as the new fingerprint for another look.
  import { apiFetch } from '../lib/api';

  let { cameraId, fingerprint, onsaved }: { cameraId: string; fingerprint: string; onsaved?: () => void } = $props();
  // The fingerprint shown now: the proxy's newer one after a 409.
  let shown = $state('');
  $effect.pre(() => {
    shown = fingerprint;
  });
  let status = $state('');
  let saving = $state(false);

  async function confirm() {
    saving = true;
    status = '';
    try {
      const res = await apiFetch(`/api/cameras/${encodeURIComponent(cameraId)}/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: shown }) });
      const body = (await res.json().catch(() => null)) as { error?: string; fingerprint?: string | null } | null;
      if (res.ok) {
        status = 'Trusted.';
        onsaved?.();
        return;
      }
      if (res.status === 409 && body?.error === 'fingerprint_changed') {
        if (body.fingerprint) {
          shown = body.fingerprint;
          status = 'The camera now shows another certificate. Check this one, then trust it.';
        } else status = 'The camera shows no certificate right now.';
      } else if (res.status === 403 && body?.error === 'proxy_admin_missing') status = "cams has no admin token for this proxy: use the proxy's admin page.";
      else if (res.status === 503) status = "The camera can't be reached.";
      else status = 'Could not trust the certificate.';
    } catch {
      status = 'Could not trust the certificate.';
    } finally {
      saving = false;
    }
  }
</script>

<div class="trust" data-testid="camera-trust">
  <p>Trust this camera’s certificate? The cam-proxy measured:</p>
  <code data-testid="trust-fingerprint">{shown}</code>
  <div><button class="primary" type="button" data-testid="trust-confirm" disabled={saving} onclick={() => void confirm()}>Trust</button></div>
  {#if status}<p class="muted" role="status" data-testid="trust-status">{status}</p>{/if}
</div>

<style>
  .trust { display: grid; gap: 10px; }
  p { margin: 0; color: var(--text); }
  code { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .muted { color: var(--muted); }
</style>
