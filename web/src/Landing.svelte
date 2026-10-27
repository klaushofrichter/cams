<script lang="ts">
  import Logo from './components/Logo.svelte';
  import CameraIllustration from './components/CameraIllustration.svelte';
  import LoginOptions from './components/LoginOptions.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import Icon from './components/Icon.svelte';
  import LandingShot from './components/LandingShot.svelte';
  import { loginMethods, noConfiguration, UNAVAILABLE_MESSAGE } from './lib/login';
  import { HIGHLIGHTS, SECTIONS, SHOWCASE } from './lib/landingContent';
  import { currentTheme } from './lib/theme';
  import { theme } from './lib/stores';
  const methods = loginMethods();
  // A form post with a wrong token comes back as /?login=failed.
  const failed = new URLSearchParams(location.search).get('login') === 'failed';
  // A form post when the token has no account (migration P4): /?login=unavailable.
  const unavailable = new URLSearchParams(location.search).get('login') === 'unavailable';
  const none = noConfiguration();
  const year = new Date().getFullYear();
  theme.set(currentTheme());
  // The product shot goes when its desktop screenshot is missing.
  let showcaseFailed = $state(false);
</script>

<div class="landing">
  <header class="nav">
    <Logo size={30} />
    <strong>cams</strong>
    <span class="by">by <a class="company" href="https://skylar.technology">Skylar Technology LLC</a></span>
    <span class="spacer"></span>
    <ThemeToggle />
  </header>

  <main>
    <section class="hero" aria-labelledby="hero-title">
      <div class="copy">
        <p class="eyebrow">Private camera system</p>
        <h1 id="hero-title">Your cameras,<br /><span class="grad">live and on record.</span></h1>
        <p class="sub">
          Live video, every event labelled by AI, and the clips you want to keep, from any browser. A small gateway next
          to your cameras keeps it all on your own hardware.
        </p>
        {#if none}<p class="notice" data-testid="no-configuration">No cameras are configured yet.</p>{/if}
        {#if unavailable}<p class="notice" role="alert" data-testid="login-unavailable">{UNAVAILABLE_MESSAGE}</p>{/if}
        <LoginOptions {methods} {failed} />
        <p class="fine">For invited accounts only.</p>
      </div>
      <div class="visual">
        <CameraIllustration />
        <span class="tag live" aria-hidden="true">● LIVE</span>
        <span class="tag person" aria-hidden="true">Person</span>
        <span class="tag vehicle" aria-hidden="true">Vehicle</span>
        <span class="tag pet" aria-hidden="true">Pet</span>
      </div>
    </section>

    <section class="highlights" data-testid="highlights" aria-labelledby="highlights-title">
      <h2 id="highlights-title" class="visually-hidden">Highlights</h2>
      {#if !showcaseFailed}
        <div class="showcase" data-testid="showcase">
          <div class="desk"><LandingShot shot={SHOWCASE.desktop} bind:failed={showcaseFailed} /></div>
          <div class="phone"><LandingShot shot={SHOWCASE.phone} frame="phone" /></div>
        </div>
      {/if}
      <ul>
        {#each HIGHLIGHTS as h (h.title)}
          <li>
            <span class="badge"><Icon name={h.icon} size={22} /></span>
            <h3>{h.title}</h3>
            <p>{h.text}</p>
          </li>
        {/each}
      </ul>
    </section>

    {#each SECTIONS as s (s.id)}
      <section class="feature" id={s.id} data-testid="feature-section" aria-labelledby="{s.id}-title">
        <div class="head">
          <p class="kicker">{s.kicker}</p>
          <h2 id="{s.id}-title">{s.title}</h2>
          <p class="lead">{s.lead}</p>
          {#if s.id === 'find'}
            <!-- An abstract strip: no real footage, just the kinds' colours. -->
            <div class="strip" aria-hidden="true">
              <i class="motion" style="left: 8%; width: 6%"></i>
              <i class="person" style="left: 21%; width: 9%"></i>
              <i class="vehicle" style="left: 41%; width: 5%"></i>
              <i class="pet" style="left: 57%; width: 7%"></i>
              <i class="person" style="left: 74%; width: 4%"></i>
              <b class="playhead" style="left: 62%"></b>
            </div>
          {/if}
        </div>
        <ul class="cards">
          {#each s.features as f (f.title)}
            <li>
              <span class="icon"><Icon name={f.icon} size={20} /></span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </li>
          {/each}
        </ul>
        {#if s.shots}
          <div class="shots" class:pair={s.shots.length > 1}>
            {#each s.shots as shot (shot.src)}
              <div class:narrow={shot.width < shot.height}><LandingShot {shot} /></div>
            {/each}
          </div>
        {/if}
      </section>
    {/each}

    <section class="maker" data-testid="maker" aria-labelledby="maker-title">
      <Logo size={44} />
      <h2 id="maker-title">Built by Skylar Technology</h2>
      <p>
        cams, its camera gateway, the fleet console and the e-paper status display are designed, built and run by
        <a class="company" href="https://skylar.technology">Skylar Technology LLC</a>. Every change is tested against a
        simulated camera that answers like the real one before it ships.
      </p>
      <a class="cta" href="https://skylar.technology">Visit skylar.technology <span aria-hidden="true">→</span></a>
    </section>
  </main>

  <footer>© {year} <a class="company" href="https://skylar.technology">Skylar Technology LLC</a> · Private system, authorised account only</footer>
</div>

<style>
  .landing {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow-x: clip;
    background:
      radial-gradient(1200px 400px at 80% -10%, color-mix(in srgb, var(--accent-2) 35%, transparent), transparent 60%),
      radial-gradient(900px 500px at 0% 40%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%),
      var(--bg);
  }
  main { flex: 1; }
  .nav { display: flex; align-items: center; gap: 10px; padding: 18px 28px; font-size: 18px; max-width: 1200px; width: 100%; margin: 0 auto; }
  .by { font-size: 13px; color: var(--muted); }
  .spacer { flex: 1; }
  .company { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; transition: color 0.15s ease; }
  .company:hover { color: var(--accent); border-bottom-style: solid; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  /* Hero */
  .hero {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 56px;
    padding: 32px 28px 56px;
    flex-wrap: wrap;
    max-width: 1200px;
    margin: 0 auto;
  }
  .copy { max-width: 540px; animation: rise 0.6s ease-out both; }
  .eyebrow, .kicker {
    margin: 0 0 10px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h1 { font-size: clamp(34px, 5.4vw, 54px); line-height: 1.06; margin: 0 0 16px; letter-spacing: -0.025em; }
  .grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { color: var(--muted); font-size: 17px; margin: 0 0 24px; }
  .fine { margin: 12px 0 0; font-size: 12px; color: var(--muted); }
  .notice { margin: 0 0 14px; padding: 10px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); }
  .visual { position: relative; display: grid; place-items: center; padding: 20px; }
  .tag {
    position: absolute;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    animation: rise 0.6s ease-out both;
  }
  .tag::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 0; }
  .tag.live { top: 6%; left: 0; color: var(--danger); animation-delay: 0.15s; }
  .tag.live::before { display: none; }
  .tag.person { top: 18%; right: -4%; animation-delay: 0.3s; }
  .tag.person::before { background: var(--kind-person); }
  .tag.vehicle { bottom: 22%; left: -6%; animation-delay: 0.45s; }
  .tag.vehicle::before { background: var(--kind-vehicle); }
  .tag.pet { bottom: 6%; right: 6%; animation-delay: 0.6s; }
  .tag.pet::before { background: var(--kind-pet); }

  /* Highlights */
  .highlights { padding: 0 28px 72px; max-width: 1200px; margin: 0 auto; }
  .highlights ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr));
  }
  .highlights li {
    padding: 20px;
    border-radius: 16px;
    background: color-mix(in srgb, var(--surface) 80%, transparent);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .badge {
    display: inline-grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: var(--grad);
    color: var(--on-grad);
    margin-bottom: 12px;
  }
  .highlights h3 { margin: 0 0 4px; font-size: 17px; }
  .highlights p { margin: 0; color: var(--muted); font-size: 14px; }

  /* The product shot: the desktop page with the phone in front, bottom right. */
  .showcase { position: relative; margin: 0 auto 40px; max-width: 1040px; padding-right: 90px; }
  .showcase .phone { position: absolute; right: 0; bottom: -28px; width: 22%; max-width: 220px; }

  /* Feature sections */
  .feature {
    display: grid;
    gap: 28px;
    padding: 56px 28px;
    max-width: 1200px;
    margin: 0 auto;
    border-top: 1px solid var(--border);
  }
  @media (min-width: 960px) {
    .feature { grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 48px; }
    .head { position: sticky; top: 24px; align-self: start; }
  }
  .feature h2 { font-size: clamp(26px, 3.4vw, 34px); line-height: 1.15; margin: 0 0 10px; letter-spacing: -0.015em; }
  .lead { margin: 0; color: var(--muted); font-size: 16px; }
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  }
  .cards li { padding: 18px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border); }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    margin-bottom: 10px;
  }
  .cards h3 { margin: 0 0 4px; font-size: 16px; }
  .cards p { margin: 0; color: var(--muted); font-size: 14px; }
  .shots { grid-column: 1 / -1; display: grid; gap: 18px; }
  .shots:empty { display: none; }
  .shots > div:empty { display: none; }
  @media (min-width: 960px) {
    /* One shot sits under the cards; a pair spans the section. */
    .shots:not(.pair) { grid-column: 2; }
    .shots.pair { grid-template-columns: 1fr 1fr; align-items: start; }
    /* A tall shot (the event list) beside a wide one. */
    .shots.pair:has(.narrow) { grid-template-columns: minmax(0, 1fr) minmax(0, 0.42fr); }
  }
  .narrow { max-width: 360px; justify-self: center; width: 100%; }
  .strip {
    position: relative;
    height: 34px;
    margin-top: 22px;
    border-radius: 8px;
    background: var(--strip-stills);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .strip i { position: absolute; top: 6px; bottom: 6px; border-radius: 4px; }
  .strip .motion { background: var(--kind-motion); }
  .strip .person { background: var(--kind-person); }
  .strip .vehicle { background: var(--kind-vehicle); }
  .strip .pet { background: var(--kind-pet); }
  .strip .playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }

  /* Maker */
  .maker {
    max-width: 760px;
    margin: 24px auto 72px;
    padding: 44px 28px;
    text-align: center;
    border-radius: 22px;
    background:
      radial-gradient(600px 220px at 50% 0%, color-mix(in srgb, var(--accent-2) 22%, transparent), transparent 70%),
      var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .maker h2 { margin: 14px 0 10px; font-size: clamp(26px, 3.6vw, 34px); letter-spacing: -0.015em; }
  .maker p { margin: 0 auto 22px; max-width: 560px; color: var(--muted); }
  .cta {
    display: inline-block;
    padding: 11px 20px;
    border-radius: 999px;
    background: var(--grad);
    color: var(--on-grad);
    font-weight: 600;
    text-decoration: none;
    transition: transform 0.15s ease;
  }
  .cta:hover { transform: translateY(-1px); }

  footer { padding: 14px 28px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }

  @media (max-width: 600px) {
    .nav { padding: 14px 16px; }
    .hero { padding: 16px 16px 40px; gap: 28px; }
    .highlights { padding: 0 16px 48px; }
    .showcase { padding-right: 48px; margin-bottom: 32px; }
    .showcase .phone { width: 30%; bottom: -16px; }
    .feature { padding: 40px 16px; }
    .maker { margin: 16px 16px 48px; padding: 32px 18px; }
    footer { padding: 14px 16px; }
    .highlights li { display: grid; grid-template-columns: 42px 1fr; column-gap: 14px; padding: 16px; }
    .highlights .badge { grid-row: span 2; margin: 0; }
    .tag.vehicle { left: 0; }
    .tag.person { right: 0; }
  }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
</style>
