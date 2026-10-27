<script lang="ts">
  // The sign-in page (/signin): the cams sign-in options, apart from the
  // start page. On the Pi and mini-PC viewers it holds the token form; a
  // token form post comes back here with ?login=failed or ?login=unavailable.
  import Logo from './components/Logo.svelte';
  import LoginOptions from './components/LoginOptions.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import { loginMethods, noConfiguration, UNAVAILABLE_MESSAGE } from './lib/login';
  import { currentTheme } from './lib/theme';
  import { theme } from './lib/stores';

  const methods = loginMethods();
  const query = new URLSearchParams(location.search);
  const failed = query.get('login') === 'failed';
  const unavailable = query.get('login') === 'unavailable';
  const none = noConfiguration();
  theme.set(currentTheme());
  document.title = 'Sign in · cams';
</script>

<div class="page">
  <header>
    <a class="home" href="/" data-testid="signin-home"><span aria-hidden="true">←</span> cams</a>
    <ThemeToggle />
  </header>
  <main>
    <section class="card" aria-labelledby="signin-title">
      <Logo size={44} />
      <h1 id="signin-title">Sign in to cams</h1>
      <p class="sub">For invited accounts only.</p>
      {#if none}<p class="notice" data-testid="no-configuration">No cameras are configured yet.</p>{/if}
      {#if unavailable}<p class="notice" role="alert" data-testid="login-unavailable">{UNAVAILABLE_MESSAGE}</p>{/if}
      <LoginOptions {methods} {failed} />
    </section>
  </main>
  <footer>© {new Date().getFullYear()} <a class="company" href="https://skylar.technology">Skylar Technology LLC</a></footer>
</div>

<style>
  .page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(900px 400px at 80% -10%, color-mix(in srgb, var(--accent-2) 30%, transparent), transparent 60%),
      var(--bg);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; }
  .home { color: var(--text); text-decoration: none; font-weight: 700; font-size: 18px; }
  .home:hover { color: var(--accent); }
  main { flex: 1; display: grid; place-items: center; padding: 24px 16px 64px; }
  .card {
    width: min(440px, 100%);
    padding: 36px 28px;
    border-radius: 22px;
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  h1 { font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif; font-weight: 600; font-size: 32px; margin: 14px 0 4px; }
  .sub { margin: 0 0 22px; color: var(--muted); }
  .notice { margin: 0 0 16px; padding: 10px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); }
  footer { padding: 14px 24px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }
  .company { color: inherit; }
</style>
