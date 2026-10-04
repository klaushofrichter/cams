<script lang="ts">
  // The start page's sign-in buttons (spec 2026-10-04-pi-deployment-design).
  // `methods` comes from <meta name="cams-login">, which the server fills in:
  // Google only (the cluster), the token only (the Pi demo kit), or both
  // (Google first; the token form behind a secondary button).
  import { untrack } from 'svelte';
  import { loginErrorMessage, signInWithToken, type LoginMethod } from '../lib/login';

  let { methods, failed = false }: { methods: LoginMethod[]; failed?: boolean } = $props();

  const google = $derived(methods.includes('google'));
  const tokenLogin = $derived(methods.includes('token'));
  let open = $state(false);
  const showForm = $derived(tokenLogin && (!google || open));
  let token = $state('');
  let busy = $state(false);
  // The page's first error only (a form post that came back ?login=failed).
  let error = $state<string | null>(untrack(() => failed) ? loginErrorMessage(401) : null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || token.length === 0) return;
    busy = true;
    error = null;
    const result = await signInWithToken(token);
    if ('redirect' in result) {
      location.assign(result.redirect);
      return;
    }
    busy = false;
    error = result.error;
  }
</script>

<div class="options" data-testid="login-options">
  {#if google}
    <a class="login" href="/auth/google/login" data-testid="login">
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="currentColor" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.1 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z" />
        <path fill="currentColor" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.5 5.8c4.4-4 6.8-10 6.8-17.2z" />
        <path fill="currentColor" d="M10.5 28.7a14.4 14.4 0 0 1 0-9.4l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.8-6z" />
        <path fill="currentColor" d="M24 48c6.1 0 11.3-2 15-5.5l-7.5-5.8c-2 1.4-4.6 2.3-7.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z" />
      </svg>
      Sign in with Google
    </a>
  {/if}

  {#if tokenLogin && google && !open}
    <button type="button" class="secondary" data-testid="token-login-open" onclick={() => (open = true)}>Sign in with token</button>
  {/if}

  {#if showForm}
    <form class="token" method="post" action="/auth/token" onsubmit={submit} data-testid="token-form">
      <label for="cams-token">Login token</label>
      <div class="row">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="cams-token"
          name="token"
          type="password"
          autocomplete="current-password"
          spellcheck="false"
          required
          autofocus={google}
          bind:value={token}
          data-testid="token-input"
        />
        <button type="submit" class={google ? 'secondary' : 'login'} disabled={busy} data-testid="token-submit">
          {busy ? 'Signing in…' : 'Sign in with token'}
        </button>
      </div>
      {#if error}
        <p class="error" role="alert" data-testid="token-error">{error}</p>
      {/if}
    </form>
  {/if}
</div>

<style>
  .options { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
  .login {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    border: 0;
    border-radius: 12px;
    background: var(--accent);
    color: var(--accent-ink);
    font: inherit;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 35%, transparent);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .login:hover { transform: translateY(-1px); box-shadow: 0 12px 28px color-mix(in srgb, var(--accent) 45%, transparent); }
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
  button:disabled { opacity: 0.6; cursor: progress; }
  .token { display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 440px; }
  label { font-size: 13px; color: var(--muted); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
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
  .error { margin: 2px 0 0; font-size: 14px; color: var(--danger); }
</style>
