<script lang="ts">
  // The viewer token sign-in (cams-admin design 2026-11-05-viewer-tokens-design
  // §9.2), three ways in: paste the token (or its link), scan its QR code with
  // the device camera, or open its link (/token#t=…: the fragment is read and
  // removed from the address before this runs, see web/index.html). A link or
  // a scan never signs in by itself: "Sign in as '<name>'?" and one button.
  // The same on every platform; the scanner only on a secure page.
  import { onDestroy, tick, untrack } from 'svelte';
  import { checkViewerToken, signInWithViewerToken, tokenFromFragment, tokenFromPaste, tokenFromScan, minuteNow, remainingText, validUntilText } from '../lib/viewerToken';
  import { scannerAvailable, startScan, type Scan } from '../lib/qrScan';

  let { fragment = null, origin = location.origin, scanner = scannerAvailable() }: { fragment?: string | null; origin?: string; scanner?: boolean } = $props();

  let input = $state('');
  // A token is a secret: masked by default, like a password (Klaus 2026-11-08).
  let shown = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let confirm = $state<{ token: string; name: string; expiresAt: number } | null>(null);
  let scanning = $state(false);
  let scanNote = $state<string | null>(null);
  let video: HTMLVideoElement | undefined = $state();
  let scan: Scan | null = null;

  // A link, a scan: show whose token it is first.
  async function ask(token: string) {
    busy = true;
    error = null;
    const r = await checkViewerToken(token);
    busy = false;
    if ('error' in r) error = r.error;
    else confirm = { token, ...r };
  }

  async function signIn(token: string) {
    busy = true;
    error = null;
    const r = await signInWithViewerToken(token);
    if ('redirect' in r) {
      location.assign(r.redirect);
      return;
    }
    busy = false;
    error = r.error;
  }

  // A paste is the person's own act: straight in.
  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    const token = tokenFromPaste(input);
    if (!token) {
      error = 'That is not a cams token. It starts with "cav_" and has 26 characters, or paste the whole sign-in link.';
      return;
    }
    input = '';
    shown = false;
    void signIn(token);
  }

  function stopScan() {
    scan?.stop();
    scan = null;
    scanning = false;
  }

  async function startScanning() {
    error = null;
    scanNote = null;
    scanning = true;
    await tick();
    if (!video) return;
    try {
      scan = await startScan(video, (text) => {
        const token = tokenFromScan(text, origin);
        if (!token) {
          scanNote = 'That QR code is not a cams sign-in for this address.';
          return false;
        }
        scan = null;
        scanning = false;
        void ask(token);
        return true;
      });
    } catch {
      stopScan();
      error = 'The camera could not be opened. Allow the camera for this page, or paste the token.';
    }
  }

  function another() {
    confirm = null;
    error = null;
  }

  // The link's fragment: at the start, and again when a link is opened on this very page.
  $effect(() => {
    const raw = fragment;
    if (!raw) return;
    untrack(() => {
      confirm = null;
      const token = tokenFromFragment(raw);
      if (token) void ask(token);
      else error = 'This sign-in link is incomplete. Copy the whole link again, or paste the token.';
    });
  });
  onDestroy(() => scan?.stop());
</script>

<div class="token-signin" data-testid="vt-page">
  {#if confirm}
    <div class="confirm" data-testid="vt-confirm">
      <p class="question" data-testid="vt-confirm-text">Sign in as '{confirm.name}'?</p>
      <p class="muted" data-testid="vt-confirm-valid">Valid until {validUntilText(confirm.expiresAt)} ({remainingText(confirm.expiresAt, $minuteNow)})</p>
      <div class="row">
        <button type="button" class="primary" disabled={busy} onclick={() => confirm && void signIn(confirm.token)} data-testid="vt-signin">{busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" class="secondary" disabled={busy} onclick={another} data-testid="vt-another">Use another token</button>
      </div>
    </div>
  {:else}
    <form class="paste" onsubmit={submit} data-testid="vt-form">
      <label for="vt-input">Token or sign-in link</label>
      <div class="row">
        <input
          id="vt-input"
          type={shown ? 'text' : 'password'}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="cav_…"
          bind:value={input}
          data-testid="vt-input"
        />
        <button type="button" class="secondary" aria-pressed={shown} onclick={() => (shown = !shown)} data-testid="vt-show">{shown ? 'Hide' : 'Show'}</button>
        <button type="submit" class="primary" disabled={busy || input.trim().length === 0} data-testid="vt-submit">{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
    </form>
    {#if scanner}
      {#if scanning}
        <div class="scanner" data-testid="vt-scanner">
          <!-- svelte-ignore a11y_media_has_caption -->
          <video bind:this={video} playsinline muted disableremoteplayback data-testid="vt-video"></video>
          <p class="muted">Point the camera at the QR code.</p>
          {#if scanNote}<p class="note" data-testid="vt-scan-note">{scanNote}</p>{/if}
          <button type="button" class="secondary" onclick={stopScan} data-testid="vt-scan-stop">Cancel</button>
        </div>
      {:else}
        <button type="button" class="secondary scan" disabled={busy} onclick={() => void startScanning()} data-testid="vt-scan">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10" /></svg>
          Scan QR code
        </button>
      {/if}
    {:else}
      <p class="muted" data-testid="vt-no-scanner">Scanning needs a secure (https) address; paste the token here instead.</p>
    {/if}
  {/if}
  {#if error}<p class="error" role="alert" data-testid="vt-error">{error}</p>{/if}
</div>

<style>
  .token-signin { display: flex; flex-direction: column; align-items: stretch; gap: 14px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  label { font-size: 13px; color: var(--muted); display: block; margin-bottom: 6px; }
  input {
    flex: 1 1 200px;
    min-width: 0;
    padding: 11px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .primary {
    padding: 11px 18px;
    border: 0;
    border-radius: 12px;
    background: var(--accent);
    color: var(--accent-ink);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  .secondary {
    padding: 10px 16px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--text) 6%, transparent);
    color: var(--text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .secondary:hover { border-color: var(--accent); }
  .scan { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
  button:disabled { opacity: 0.6; cursor: progress; }
  .scanner { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
  video { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--border); }
  .question { margin: 0; font-size: 20px; font-weight: 700; overflow-wrap: anywhere; }
  .muted { margin: 0; color: var(--muted); font-size: 14px; }
  .note { margin: 0; font-size: 14px; }
  .error { margin: 0; font-size: 14px; color: var(--danger); }
  .confirm { display: flex; flex-direction: column; gap: 12px; }
</style>
