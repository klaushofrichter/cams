<script lang="ts">
  // What an admin can do from cams about a camera behind a cam-proxy that is
  // offline (spec 2026-10-30-camera-onboarding-design §6.2): the camera's
  // password ("Enter password") and its certificate ("Trust certificate"),
  // both relayed to the proxy with cams's proxy-admin token. Without one,
  // both stay disabled with a pointer to the proxy's own admin page.
  import Modal from './Modal.svelte';
  import CameraLogin from './CameraLogin.svelte';
  import CameraTrust from './CameraTrust.svelte';
  import { isAdmin } from '../lib/session';
  import { me } from '../lib/stores';
  import { checkLiveStatus, type OfflineFixInfo } from '../lib/liveUi';

  // error: the status's error; a certificate problem without a measured
  // fingerprint yet is asked for again every 5 s, at most a minute, so the
  // Trust button appears without a reload.
  let { cameraId, fix, error = '' }: { cameraId: string; fix: OfflineFixInfo; error?: string } = $props();
  let dialog: 'password' | 'trust' | null = $state(null);
  const POLL_MS = 5000, POLL_MAX = 12;
  let polled = 0;
  let polledFor = '';
  const waiting = $derived(isAdmin($me) && !fix.trust && (error === 'camera_untrusted' || error === 'camera_cert_changed'));
  $effect(() => {
    if (polledFor !== cameraId) {
      polledFor = cameraId;
      polled = 0;
    }
    if (!waiting) return;
    const id = cameraId;
    const timer = setInterval(() => {
      if (polled >= POLL_MAX) return clearInterval(timer);
      polled++;
      void checkLiveStatus(id);
    }, POLL_MS);
    return () => clearInterval(timer);
  });

  function done() {
    dialog = null;
    void checkLiveStatus(cameraId);
  }
</script>

{#if isAdmin($me) && (fix.login || fix.trust)}
  <div class="fix" data-testid="offline-fix">
    {#if fix.login}
      <button type="button" data-testid="offline-password" disabled={!fix.canFix} onclick={() => (dialog = 'password')}>Enter password</button>
    {/if}
    {#if fix.trust}
      <button type="button" data-testid="offline-trust" disabled={!fix.canFix} onclick={() => (dialog = 'trust')}>Trust certificate</button>
    {/if}
    {#if !fix.canFix}<span class="hint" data-testid="offline-fix-hint">cams has no admin token for this proxy: use the proxy’s admin page.</span>{/if}
  </div>
{/if}

{#if dialog === 'password'}
  <Modal title="Camera login" testid="offline-password-dialog" onclose={() => (dialog = null)}>
    <CameraLogin {cameraId} embedded authFailed={fix.login === 'refused'} missing={fix.login === 'missing'} onsaved={done} />
  </Modal>
{:else if dialog === 'trust' && fix.trust}
  <Modal title="Camera certificate" testid="offline-trust-dialog" onclose={() => (dialog = null)}>
    <CameraTrust {cameraId} fingerprint={fix.trust.fingerprint} onsaved={done} />
  </Modal>
{/if}

<style>
  .fix { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button {
    font: inherit; padding: 6px 12px; border-radius: 9px; cursor: pointer;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink);
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { font-size: 12px; color: var(--muted); }
</style>
