<script lang="ts">
  // The viewer token sign-in page (/token, cams-admin design
  // 2026-11-05-viewer-tokens-design §9.2), in the sign-in page's frame. The
  // link's fragment was taken out of the address by web/index.html before
  // any module ran; it is handed over here once and forgotten.
  import Logo from './components/Logo.svelte';
  import TokenSignIn from './components/TokenSignIn.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import { currentTheme } from './lib/theme';
  import { theme } from './lib/stores';
  import { onMount } from 'svelte';

  const w = window as unknown as { camsTokenFragment?: string };
  let fragment = $state<string | null>(w.camsTokenFragment ?? null);
  delete w.camsTokenFragment;
  // A fragment index.html didn't take (the Vite dev server), or a link opened
  // on this page (no new page load): the same, here.
  function takeFragment() {
    if (!location.hash) return;
    fragment = location.hash;
    history.replaceState(null, '', '/token');
  }
  takeFragment();
  onMount(() => {
    addEventListener('hashchange', takeFragment);
    return () => removeEventListener('hashchange', takeFragment);
  });
  theme.set(currentTheme());
  document.title = 'Sign in with a token · cams';
  import { externalLinks } from './lib/externalLinks';
</script>

<div class="page" use:externalLinks={'signin-new-tab'}>
  <span id="signin-new-tab" class="nt-hint">opens in a new tab</span>
  <header>
    <a class="home" href="/" data-testid="signin-home"><span aria-hidden="true">←</span> cams</a>
    <ThemeToggle />
  </header>
  <main>
    <section class="card" aria-labelledby="signin-title">
      <Logo size={44} />
      <h1 id="signin-title">Sign in with a token</h1>
      <p class="sub">A token from your cams administrator lets you watch cameras for a limited time.</p>
      <TokenSignIn {fragment} />
      <p class="other"><a href="/signin" data-testid="vt-other-signin">Other ways to sign in</a></p>
    </section>
  </main>
  <footer>© {new Date().getFullYear()} <a class="company" href="https://skylar.technology">Skylar Technology LLC</a></footer>
</div>

<style>
  .nt-hint { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .page {
    /* The accent at 4.5:1 for text and buttons in both themes (theme.css). */
    --accent: var(--accent-text);
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
  .other { margin: 22px 0 0; font-size: 14px; }
  .other a { color: var(--accent); }
  footer { padding: 14px 24px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }
  .company { color: inherit; }
</style>
