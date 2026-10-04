<script lang="ts">
  import Logo from './components/Logo.svelte';
  import CameraIllustration from './components/CameraIllustration.svelte';
  import LoginOptions from './components/LoginOptions.svelte';
  import { loginMethods } from './lib/login';
  const methods = loginMethods();
  // A form post with a wrong token comes back as /?login=failed.
  const failed = new URLSearchParams(location.search).get('login') === 'failed';
  const year = new Date().getFullYear();
</script>

<div class="landing">
  <header class="nav">
    <Logo size={30} />
    <strong>cams</strong>
    <span class="by">by <a class="company" href="https://skylar.technology">Skylar Technology LLC</a></span>
  </header>

  <main class="hero">
    <section class="copy">
      <h1>Your cameras,<br /><span class="grad">live and on record.</span></h1>
      <p>
        cams is Skylar Technology's private viewer for our Reolink security cameras: live video, a timeline of every
        recorded event with AI detection of people, vehicles and pets, clip downloads and camera settings, from any
        browser.
      </p>
      <LoginOptions {methods} {failed} />
      <ul class="chips">
        <li>● Live view</li>
        <li>◷ Timeline playback</li>
        <li>⚑ AI events</li>
        <li>⤓ Downloads</li>
      </ul>
    </section>
    <CameraIllustration />
  </main>

  <footer>© {year} <a class="company" href="https://skylar.technology">Skylar Technology LLC</a> · Private system, authorised account only</footer>
</div>

<style>
  .landing {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(1200px 400px at 80% -10%, color-mix(in srgb, var(--accent-2) 35%, transparent), transparent 60%),
      radial-gradient(900px 400px at 0% 110%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 60%),
      var(--bg);
  }
  .nav { display: flex; align-items: center; gap: 10px; padding: 18px 28px; font-size: 18px; }
  .by { font-size: 13px; color: var(--muted); }
  .company { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; transition: color 0.15s ease; }
  .company:hover { color: var(--accent); border-bottom-style: solid; }
  .hero {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 56px;
    padding: 24px 28px 48px;
    flex-wrap: wrap;
  }
  .copy { max-width: 520px; animation: rise 0.6s ease-out both; }
  h1 { font-size: clamp(32px, 5vw, 48px); line-height: 1.1; margin: 0 0 14px; letter-spacing: -0.02em; }
  .grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { color: var(--muted); font-size: 16px; margin: 0 0 22px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 20px 0 0; }
  .chips li {
    font-size: 12px;
    padding: 4px 11px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text) 6%, transparent);
    border: 1px solid var(--border);
    color: var(--muted);
  }
  footer { padding: 14px 28px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
</style>
