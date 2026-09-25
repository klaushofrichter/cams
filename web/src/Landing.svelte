<script lang="ts">
  import Logo from './components/Logo.svelte';
  import CameraIllustration from './components/CameraIllustration.svelte';
  const year = new Date().getFullYear();
</script>

<div class="landing">
  <header class="nav">
    <Logo size={30} />
    <strong>cams</strong>
    <span class="by">by Skylar Technology LLC</span>
  </header>

  <main class="hero">
    <section class="copy">
      <h1>Your cameras,<br /><span class="grad">live and on record.</span></h1>
      <p>
        cams is Skylar Technology's private viewer for our Reolink security cameras: live video, a timeline of every
        recorded event with AI detection of people, vehicles and pets, clip downloads and camera settings, from any
        browser.
      </p>
      <a class="login" href="/auth/google/login" data-testid="login">
        <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="currentColor" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.1 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z" />
          <path fill="currentColor" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.5 5.8c4.4-4 6.8-10 6.8-17.2z" />
          <path fill="currentColor" d="M10.5 28.7a14.4 14.4 0 0 1 0-9.4l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.8-6z" />
          <path fill="currentColor" d="M24 48c6.1 0 11.3-2 15-5.5l-7.5-5.8c-2 1.4-4.6 2.3-7.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z" />
        </svg>
        Sign in with Google
      </a>
      <ul class="chips">
        <li>● Live view</li>
        <li>◷ Timeline playback</li>
        <li>⚑ AI events</li>
        <li>⤓ Downloads</li>
      </ul>
    </section>
    <CameraIllustration />
  </main>

  <footer>© {year} Skylar Technology LLC · Private system, authorised account only</footer>
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
  .login {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    border-radius: 12px;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    text-decoration: none;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 35%, transparent);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .login:hover { transform: translateY(-1px); box-shadow: 0 12px 28px color-mix(in srgb, var(--accent) 45%, transparent); }
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
