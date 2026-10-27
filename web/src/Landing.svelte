<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Logo from './components/Logo.svelte';
  import CameraIllustration from './components/CameraIllustration.svelte';
  import LoginOptions from './components/LoginOptions.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import Icon from './components/Icon.svelte';
  import LandingShot from './components/LandingShot.svelte';
  import { loginMethods, noConfiguration, UNAVAILABLE_MESSAGE } from './lib/login';
  import { ADMIN_CONSOLE_URL, HIGHLIGHTS, NUMBERS, REPOS, SECTIONS, SHOWCASE } from './lib/landingContent';
  import { countUp, reducedMotion, reveal, spotlight } from './lib/landingMotion';
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

  // The sign-in sits in the header. Up to this width it is behind a compact
  // "Sign in" button; it opens by itself when a token sign-in came back failed.
  const COMPACT = '(max-width: 899px)';
  const compact = () => typeof matchMedia === 'function' && matchMedia(COMPACT).matches;
  let menuOpen = $state(failed && compact());
  let header: HTMLElement;
  let panel: HTMLElement;
  let scrolled = $state(false);
  // The product shot goes when its desktop screenshot is missing.
  let showcaseFailed = $state(false);
  let hero: HTMLElement;

  async function heroSignIn() {
    if (compact()) menuOpen = true;
    await tick();
    panel.querySelector<HTMLElement>('a.login, input, button')?.focus();
  }

  onMount(() => {
    const onScroll = () => (scrolled = window.scrollY > 8);
    const onDown = (e: PointerEvent) => {
      if (menuOpen && !header.contains(e.target as Node)) menuOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menuOpen) menuOpen = false;
    };
    // The camera leans a little towards the pointer.
    const onMove = (e: PointerEvent) => {
      hero.style.setProperty('--px', (e.clientX / window.innerWidth - 0.5).toFixed(3));
      hero.style.setProperty('--py', (e.clientY / window.innerHeight - 0.5).toFixed(3));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    const still = reducedMotion();
    if (!still) hero.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      hero.removeEventListener('pointermove', onMove);
    };
  });
</script>

<div class="landing">
  <header class="nav" class:scrolled bind:this={header}>
    <div class="inner">
      <a class="brand" href="#top" aria-label="cams, back to the top"><Logo size={30} /></a>
      <div class="name">
        <strong>cams</strong>
        <span class="by">by <a class="company" href="https://skylar.technology">Skylar Technology LLC</a></span>
      </div>
      <span class="spacer"></span>
      <ThemeToggle />
      <button
        type="button"
        class="signin-toggle"
        data-testid="signin-toggle"
        aria-expanded={menuOpen}
        aria-controls="signin-panel"
        onclick={() => (menuOpen = !menuOpen)}
      >
        Sign in
      </button>
      <div class="signin" class:open={menuOpen} id="signin-panel" bind:this={panel}>
        <a class="admin" href={ADMIN_CONSOLE_URL} data-testid="admin-console">Admin console <Icon name="external" size={14} /></a>
        <LoginOptions {methods} {failed} />
      </div>
    </div>
  </header>

  <main id="top">
    <section class="hero" aria-labelledby="hero-title" bind:this={hero}>
      <div class="copy">
        {#if none}<p class="notice" data-testid="no-configuration">No cameras are configured yet.</p>{/if}
        {#if unavailable}<p class="notice" role="alert" data-testid="login-unavailable">{UNAVAILABLE_MESSAGE}</p>{/if}
        <p class="eyebrow">Private camera system · Open source</p>
        <h1 id="hero-title">Your cameras,<br /><em class="grad">live and on record.</em></h1>
        <p class="sub">
          Live video, every event labelled by AI, and the clips you want to keep, from any browser. A small proxy next to
          your cameras keeps the footage on your own network.
        </p>
        <div class="ctas">
          <a class="btn primary" href="#highlights">See what it does <span aria-hidden="true">→</span></a>
          <button type="button" class="btn" data-testid="hero-signin" onclick={heroSignIn}>Sign in</button>
        </div>
      </div>
      <div class="visual">
        <div class="lean"><CameraIllustration /></div>
        <span class="tag live" aria-hidden="true">● LIVE</span>
        <span class="tag person" aria-hidden="true">Person</span>
        <span class="tag vehicle" aria-hidden="true">Vehicle</span>
        <span class="tag pet" aria-hidden="true">Pet</span>
      </div>
      <a class="cue" href="#highlights" aria-label="Scroll to the highlights"></a>
    </section>

    <!-- The five repositories, drifting by; each name opens its repository.
         The loop's second copy is for the eye only. -->
    <nav class="marquee" aria-label="The repositories" data-testid="ticker">
      <div class="track" data-testid="ticker-track">
        <div class="group">
          {#each REPOS as r (r.name)}<a href={r.url} data-testid="ticker-link">{r.name}</a><i aria-hidden="true">✦</i>{/each}
        </div>
        <div class="group" aria-hidden="true">
          {#each REPOS as r (r.name)}<a href={r.url} tabindex="-1" data-testid="ticker-copy">{r.name}</a><i>✦</i>{/each}
        </div>
      </div>
    </nav>

    <section class="numbers" aria-label="In numbers">
      {#each NUMBERS as n, i (n.label)}
        <div class="num" use:reveal={i * 80}>
          <b use:countUp={{ value: n.value, suffix: n.suffix }}>{n.value}{n.suffix}</b>
          <span>{n.label}</span>
        </div>
      {/each}
    </section>

    <section class="highlights" id="highlights" data-testid="highlights" aria-labelledby="highlights-title">
      <div class="section-head" use:reveal>
        <p class="eyebrow">Highlights</p>
        <h2 id="highlights-title">Everything a camera system should do</h2>
      </div>
      {#if !showcaseFailed}
        <div class="showcase" data-testid="showcase" use:reveal>
          <div class="desk"><LandingShot shot={SHOWCASE.desktop} bind:failed={showcaseFailed} /></div>
          <div class="phone"><LandingShot shot={SHOWCASE.phone} frame="phone" /></div>
        </div>
      {/if}
      <ul>
        {#each HIGHLIGHTS as h, i (h.section)}
          <li use:reveal={(i % 4) * 70}>
            <a class="hl spot" href="#{h.section}" data-testid="highlight" use:spotlight>
              <span class="badge"><Icon name={h.icon} size={22} /></span>
              <span class="kicker">{h.kicker}</span>
              <h3>{h.title}</h3>
              <p>{h.text}</p>
              <span class="more">Read more <span aria-hidden="true">→</span></span>
            </a>
          </li>
        {/each}
      </ul>
    </section>

    {#each SECTIONS as s (s.id)}
      <section class="feature" id={s.id} data-testid="feature-section" aria-labelledby="{s.id}-title">
        <div class="head" use:reveal>
          <p class="eyebrow">{s.kicker}</p>
          <h2 id="{s.id}-title">{s.title}</h2>
          <p class="lead">{s.lead}</p>
          {#if s.id === 'find'}
            <!-- An abstract strip: no footage, just the kinds' colours. -->
            <div class="strip" aria-hidden="true">
              <i class="motion" style="left: 8%; width: 6%"></i>
              <i class="person" style="left: 21%; width: 9%"></i>
              <i class="vehicle" style="left: 41%; width: 5%"></i>
              <i class="pet" style="left: 57%; width: 7%"></i>
              <i class="person" style="left: 74%; width: 4%"></i>
              <b class="playhead"></b>
            </div>
          {/if}
        </div>
        <div class="body">
          <ul class="cards">
            {#each s.features as f, i (f.title)}
              <li class="spot" use:reveal={(i % 2) * 80} use:spotlight>
                <span class="icon"><Icon name={f.icon} size={20} /></span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </li>
            {/each}
          </ul>
          {#if s.id === 'open'}
            <ul class="repos" use:reveal>
              {#each REPOS as r (r.name)}
                <li>
                  <a href={r.url} data-testid="repo-link">
                    <Icon name="code" size={18} />
                    <span><b>{r.name}</b><small>{r.text}</small></span>
                    <Icon name="external" size={14} />
                  </a>
                </li>
              {/each}
            </ul>
          {/if}
          {#if s.shots}
            <div class="shots" class:pair={s.shots.length > 1}>
              {#each s.shots as shot, i (shot.src)}
                <div class:narrow={shot.width < shot.height} class:epaper={shot.frame === 'epaper'} use:reveal={i * 100}><LandingShot {shot} /></div>
              {/each}
            </div>
          {/if}
        </div>
      </section>
    {/each}

    <section class="maker" data-testid="maker" aria-labelledby="maker-title" use:reveal>
      <Logo size={44} />
      <h2 id="maker-title">Built by Skylar Technology</h2>
      <p>
        cams, cam-proxy, cam-sim, cams-admin and the e-paper display are designed, built and run by
        <a class="company" href="https://skylar.technology">Skylar Technology LLC</a>.
      </p>
      <a class="btn primary" href="https://skylar.technology">Visit skylar.technology <span aria-hidden="true">→</span></a>
    </section>
  </main>

  <footer>© {year} <a class="company" href="https://skylar.technology">Skylar Technology LLC</a> · Private system, authorised account only</footer>
</div>

<style>
  :global(html) { scroll-padding-top: 76px; }
  @media (prefers-reduced-motion: no-preference) {
    :global(html) { scroll-behavior: smooth; }
  }

  .landing {
    --display: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
    --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow-x: clip;
    background:
      radial-gradient(1200px 500px at 85% -10%, color-mix(in srgb, var(--accent-2) 30%, transparent), transparent 60%),
      radial-gradient(900px 600px at -10% 30%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%),
      radial-gradient(900px 600px at 110% 75%, color-mix(in srgb, var(--accent-2) 12%, transparent), transparent 60%),
      var(--bg);
  }
  main { flex: 1; }
  .hero, .numbers, .highlights, .feature { width: min(1180px, calc(100% - 48px)); margin-inline: auto; }

  /* Reveal on scroll (landingMotion.ts adds .rv, then .in). */
  .landing :global(.rv) { opacity: 0; transform: translateY(28px); transition: opacity 0.9s var(--ease), transform 0.9s var(--ease); }
  .landing :global(.rv.in) { opacity: 1; transform: none; }

  /* Header: transparent at the top, frosted once the page scrolls. */
  .nav { position: sticky; top: 0; z-index: 30; border-bottom: 1px solid transparent; transition: background-color 0.3s, border-color 0.3s, backdrop-filter 0.3s; }
  .nav.scrolled { background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(14px); border-bottom-color: var(--border); }
  .inner { position: relative; display: flex; align-items: center; gap: 12px; width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 14px 0; }
  .brand { display: inline-flex; }
  .name { display: flex; align-items: baseline; gap: 10px; font-size: 18px; }
  .by { font-size: 13px; color: var(--muted); }
  .spacer { flex: 1; }
  .company { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; transition: color 0.15s ease; }
  .company:hover { color: var(--accent); border-bottom-style: solid; }
  .signin { display: flex; align-items: center; gap: 14px; }
  .admin { display: inline-flex; align-items: center; gap: 5px; font-size: 14px; color: var(--muted); text-decoration: none; white-space: nowrap; transition: color 0.2s; }
  .admin:hover { color: var(--text); }
  /* LoginOptions laid out in a row for the header. */
  .signin :global(.options) { flex-direction: row; align-items: center; gap: 10px; }
  .signin :global(.login) { padding: 9px 16px; border-radius: 999px; font-size: 14px; }
  .signin :global(.secondary) { padding: 8px 14px; border-radius: 999px; font-size: 14px; }
  .signin :global(.token) { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px; max-width: 380px; }
  .signin :global(.token label) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .signin :global(.token input) { flex-basis: 170px; padding: 8px 12px; border-radius: 999px; }
  .signin :global(.error) { flex-basis: 100%; }
  .signin-toggle { display: none; padding: 8px 14px; border-radius: 999px; border: 0; background: var(--accent); color: var(--accent-ink); font-weight: 700; cursor: pointer; }
  @media (max-width: 899px) {
    .by { display: block; font-size: 11px; }
    .name { flex-direction: column; gap: 0; line-height: 1.2; }
    .signin-toggle { display: inline-block; }
    .signin {
      display: none;
      position: absolute;
      top: calc(100% - 4px);
      right: 0;
      width: min(340px, 100%);
      flex-direction: column-reverse;
      align-items: stretch;
      gap: 14px;
      padding: 16px;
      border-radius: 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
    }
    .signin.open { display: flex; animation: drop 0.25s var(--ease); }
    .signin :global(.options) { flex-direction: column; align-items: stretch; }
    .signin :global(.login) { justify-content: center; }
    .signin :global(.token) { flex-direction: column; align-items: stretch; max-width: none; }
    .signin :global(.token label) { position: static; width: auto; height: auto; clip-path: none; }
    .signin :global(.token input) { flex-basis: auto; }
    .admin { justify-content: center; padding-top: 10px; border-top: 1px solid var(--border); }
  }

  /* Hero */
  .hero {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
    align-items: center;
    gap: 40px;
    min-height: min(820px, calc(100vh - 64px));
    padding: 40px 0 96px;
  }
  .hero::before {
    /* A faint grid behind the hero, fading out. */
    content: '';
    position: absolute;
    inset: -80px -50vw 0;
    z-index: -1;
    background-image:
      linear-gradient(to right, color-mix(in srgb, var(--border) 60%, transparent) 1px, transparent 1px),
      linear-gradient(to bottom, color-mix(in srgb, var(--border) 60%, transparent) 1px, transparent 1px);
    background-size: 56px 56px;
    mask-image: radial-gradient(ellipse 70% 60% at 60% 40%, #000 20%, transparent 75%);
  }
  .copy { max-width: 620px; animation: rise 0.9s var(--ease) both; }
  .eyebrow { margin: 0 0 14px; font-size: 12px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: var(--accent); }
  h1 { font-family: var(--display); font-weight: 600; font-size: clamp(44px, 7vw, 88px); line-height: 1.02; margin: 0 0 22px; letter-spacing: -0.01em; }
  h1 em { font-style: italic; }
  .grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; padding-right: 0.08em; }
  .sub { color: var(--muted); font-size: 19px; line-height: 1.6; margin: 0 0 30px; max-width: 560px; }
  .ctas { display: flex; flex-wrap: wrap; gap: 12px; }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 13px 24px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--text) 4%, transparent);
    color: var(--text);
    font: inherit;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s, background-color 0.2s;
  }
  .btn:hover { transform: translateY(-2px); border-color: var(--accent); }
  .btn.primary { background: var(--grad); color: var(--on-grad); border-color: transparent; box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 28%, transparent); }
  .btn.primary:hover { box-shadow: 0 14px 40px color-mix(in srgb, var(--accent) 40%, transparent); }
  .notice { margin: 0 0 18px; padding: 10px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text); }
  .visual { position: relative; display: grid; place-items: center; padding: 24px; animation: rise 1.1s var(--ease) 0.1s both; }
  .lean { transform: translate(calc(var(--px, 0) * 18px), calc(var(--py, 0) * 14px)) rotate(calc(var(--px, 0) * 4deg)); transition: transform 0.6s var(--ease); }
  .tag {
    position: absolute;
    font-size: 13px;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    backdrop-filter: blur(6px);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    animation: bob 5s ease-in-out infinite;
  }
  .tag::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; }
  .tag.live { top: 6%; left: 2%; color: var(--danger); }
  .tag.live::before { display: none; }
  .tag.person { top: 18%; right: 0; animation-delay: 0.8s; }
  .tag.person::before { background: var(--kind-person); }
  .tag.vehicle { bottom: 24%; left: 0; animation-delay: 1.6s; }
  .tag.vehicle::before { background: var(--kind-vehicle); }
  .tag.pet { bottom: 6%; right: 8%; animation-delay: 2.4s; }
  .tag.pet::before { background: var(--kind-pet); }
  .cue { position: absolute; left: 50%; bottom: 24px; width: 26px; height: 42px; margin-left: -13px; border: 2px solid var(--border); border-radius: 14px; }
  .cue::after { content: ''; position: absolute; left: 50%; top: 8px; width: 4px; height: 8px; margin-left: -2px; border-radius: 2px; background: var(--accent); animation: cue 1.8s ease infinite; }

  /* The marquee: the five parts' names, outlined, drifting by. */
  .marquee { overflow: hidden; padding: 24px 0; border-block: 1px solid var(--border); background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--surface) 60%, transparent), transparent); }
  .track { display: flex; width: max-content; animation: marquee 40s linear infinite; }
  .marquee:hover .track, .marquee:focus-within .track { animation-play-state: paused; }
  .group { display: flex; align-items: center; gap: 36px; padding-right: 36px; }
  .group a { font: 600 clamp(30px, 4.2vw, 58px)/1 var(--display); color: transparent; -webkit-text-stroke: 1px color-mix(in srgb, var(--text) 45%, transparent); white-space: nowrap; text-decoration: none; transition: color 0.3s; }
  .group a:hover, .group a:focus-visible { color: var(--text); }
  .track i { font-style: normal; color: var(--accent); font-size: 20px; }

  /* Numbers */
  .numbers { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px; padding: 72px 0 24px; }
  .num { display: grid; gap: 6px; padding-left: 20px; border-left: 2px solid var(--accent); }
  .num b { font: 600 clamp(44px, 5vw, 68px)/1 var(--display); background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .num span { color: var(--muted); font-size: 15px; }

  /* Section heads */
  h2 { font-family: var(--display); font-weight: 600; font-size: clamp(32px, 4vw, 50px); line-height: 1.1; margin: 0 0 14px; letter-spacing: -0.005em; }
  .section-head { max-width: 760px; margin-bottom: 44px; }

  /* Highlights */
  .highlights { padding: 96px 0 40px; }
  .highlights ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); }
  .hl {
    position: relative;
    display: grid;
    gap: 6px;
    align-content: start;
    height: 100%;
    padding: 22px;
    border-radius: 20px;
    background: linear-gradient(160deg, var(--surface), color-mix(in srgb, var(--surface) 55%, transparent));
    border: 1px solid var(--border);
    color: inherit;
    text-decoration: none;
    overflow: hidden;
    transition: transform 0.3s var(--ease), border-color 0.3s, box-shadow 0.3s;
  }
  .hl:hover { transform: translateY(-6px); border-color: var(--accent); box-shadow: var(--shadow); }
  .badge { display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--grad); color: var(--on-grad); margin-bottom: 8px; transition: transform 0.4s var(--ease); }
  .hl:hover .badge { transform: rotate(-6deg) scale(1.06); }
  .kicker { font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent); }
  .hl h3 { margin: 0; font-size: 18px; }
  .hl p { margin: 0; color: var(--muted); font-size: 14px; }
  .more { margin-top: 8px; font-size: 13px; font-weight: 600; color: var(--accent); }
  .more span { display: inline-block; transition: transform 0.3s var(--ease); }
  .hl:hover .more span { transform: translateX(4px); }

  /* The spotlight that follows the pointer over a card (landingMotion.ts). */
  .spot { position: relative; isolation: isolate; }
  .spot::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: radial-gradient(320px circle at var(--mx, -999px) var(--my, -999px), color-mix(in srgb, var(--accent) 14%, transparent), transparent 60%);
    pointer-events: none;
    z-index: -1;
    opacity: 0;
    transition: opacity 0.3s;
  }
  .spot:hover::after { opacity: 1; }

  /* The product shot: the desktop page with the phone in front, bottom right. */
  .showcase { position: relative; margin: 0 auto 56px; max-width: 1040px; padding-right: 90px; }
  .showcase .desk { transform: perspective(1600px) rotateX(4deg); transform-origin: 50% 100%; transition: transform 0.8s var(--ease); }
  .showcase:hover .desk { transform: none; }
  .showcase .phone { position: absolute; right: 0; bottom: -28px; width: 22%; max-width: 220px; transform: rotate(3deg); transition: transform 0.8s var(--ease); }
  .showcase:hover .phone { transform: rotate(0) translateY(-6px); }

  /* Feature sections */
  .feature { display: grid; gap: 32px; padding: 96px 0; border-top: 1px solid var(--border); }
  @media (min-width: 960px) {
    .feature { grid-template-columns: minmax(0, 360px) minmax(0, 1fr); gap: 56px; }
    .head { position: sticky; top: 96px; align-self: start; }
  }
  .lead { margin: 0; color: var(--muted); font-size: 17px; }
  .body { display: grid; gap: 28px; min-width: 0; }
  .cards { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
  .cards li {
    padding: 20px;
    border-radius: 18px;
    background: color-mix(in srgb, var(--surface) 75%, transparent);
    border: 1px solid var(--border);
    overflow: hidden;
    transition: transform 0.3s var(--ease), border-color 0.3s, opacity 0.9s var(--ease);
  }
  .cards li:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
  .icon { display: inline-grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); margin-bottom: 10px; }
  .cards h3 { margin: 0 0 4px; font-size: 16px; }
  .cards p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
  .strip { position: relative; height: 34px; margin-top: 24px; border-radius: 8px; background: var(--strip-stills); border: 1px solid var(--border); overflow: hidden; }
  .strip i { position: absolute; top: 6px; bottom: 6px; border-radius: 4px; }
  .strip .motion { background: var(--kind-motion); }
  .strip .person { background: var(--kind-person); }
  .strip .vehicle { background: var(--kind-vehicle); }
  .strip .pet { background: var(--kind-pet); }
  .strip .playhead { position: absolute; top: 0; bottom: 0; left: 62%; width: 2px; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); animation: scrub 9s ease-in-out infinite alternate; }

  /* Screenshots */
  .shots { display: grid; gap: 20px; }
  .shots:empty, .shots > div:empty { display: none; }
  .shots > div { transition: transform 0.6s var(--ease), opacity 0.9s var(--ease); }
  .shots > div:not(.epaper) { transform: rotate(0.6deg); }
  .shots > div:not(.epaper):hover { transform: rotate(0) scale(1.01); }
  @media (min-width: 960px) {
    .shots.pair { grid-template-columns: 1fr 1fr; align-items: start; }
    /* A tall shot (the event list) beside a wide one. */
    .shots.pair:has(.narrow) { grid-template-columns: minmax(0, 1fr) minmax(0, 0.42fr); }
  }
  .narrow { max-width: 360px; justify-self: center; width: 100%; }

  .repos { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); }
  .repos a {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 60%, transparent);
    color: var(--text);
    text-decoration: none;
    transition: border-color 0.2s, transform 0.2s;
  }
  .repos a:hover { border-color: var(--accent); transform: translateY(-2px); }
  .repos b { display: block; font-family: var(--mono); font-size: 14px; }
  .repos small { color: var(--muted); font-size: 13px; }

  /* Maker */
  .maker {
    width: min(820px, calc(100% - 32px));
    margin: 40px auto 96px;
    padding: 56px 32px;
    text-align: center;
    border-radius: 28px;
    background:
      radial-gradient(600px 240px at 50% 0%, color-mix(in srgb, var(--accent-2) 24%, transparent), transparent 70%),
      var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .maker h2 { margin: 16px 0 12px; }
  .maker p { margin: 0 auto 26px; max-width: 560px; color: var(--muted); }

  footer { padding: 16px 24px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }

  @media (max-width: 899px) {
    .hero { grid-template-columns: minmax(0, 1fr); min-height: 0; padding: 24px 0 80px; gap: 16px; }
    .numbers { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 600px) {
    .inner, .hero, .numbers, .highlights, .feature { width: calc(100% - 32px); }
    .highlights { padding-top: 72px; }
    .feature { padding: 64px 0; }
    .showcase { padding-right: 48px; margin-bottom: 40px; }
    .showcase .phone { width: 30%; bottom: -16px; }
    .hl { grid-template-columns: 44px 1fr; column-gap: 14px; padding: 16px; }
    .hl .badge { grid-row: span 4; margin: 0; }
    .sub { font-size: 17px; }
    .maker { padding: 40px 20px; }
  }

  @keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
  @keyframes drop { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  @keyframes bob { 50% { transform: translateY(-8px); } }
  @keyframes cue { 0% { opacity: 0; transform: translateY(0); } 40% { opacity: 1; } 80%, 100% { opacity: 0; transform: translateY(12px); } }
  @keyframes marquee { to { transform: translateX(-50%); } }
  @keyframes scrub { from { left: 12%; } to { left: 86%; } }

  /* Nothing moves under reduced motion (theme.css zeroes the durations; the
     endless loops stop here too, and reveals show at once in landingMotion.ts). */
  @media (prefers-reduced-motion: reduce) {
    .tag, .cue::after, .track, .strip .playhead, .copy, .visual { animation: none; }
    .lean, .showcase .desk, .showcase .phone, .shots > div:not(.epaper) { transform: none; }
  }
</style>
