<script lang="ts">
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Icon from './components/Icon.svelte';
  import Live from './pages/Live.svelte';
  import Recordings from './pages/Recordings.svelte';
  import Settings from './pages/Settings.svelte';
  import About from './pages/About.svelte';
  import { initRouter, route } from './lib/router';
  import { cameras, drawerOpen, me, selectedCameraId, theme, type CameraSummary, type Me } from './lib/stores';
  import { getJson, UnauthorizedError } from './lib/api';
  import { loadPreferences, preferences } from './lib/preferences';
  import { createKeepAlive } from './lib/keepAlive';
  import { duration } from './lib/motion';
  import { currentTheme } from './lib/theme';

  let loadError = $state('');
  // Preferences (and the default-camera selection derived from them) must
  // settle before any page mounts, so a page that reads a preference at
  // init (Live's initialQuality, Timeline's initial zoom) sees the real
  // value instead of racing it. This gate covers success and failure
  // alike -- a failed preferences load still finishes `load()`.
  let ready = $state(false);
  let drawerPanelEl: HTMLDivElement | undefined = $state();
  let drawerWasOpen = false;

  // The Live page stays mounted (but hidden) for the chosen keep-alive time
  // after the user leaves it, so its stream keeps playing in the background
  // and coming back shows the picture at once. When the time runs out, Live
  // is unmounted and its onDestroy closes the stream. Live's <video> is never
  // moved in the DOM: removing a media element pauses it.
  let liveMounted = $state(false);
  const keepAlive = createKeepAlive(() => (liveMounted = false));
  let wasLive = false;
  let leftWith: number | null = null;
  $effect(() => {
    // Nothing before `ready`: the router store starts out on 'live' until
    // initRouter() syncs it, and a deep link to another page must not
    // briefly mount Live (and open a stream nobody asked for).
    if (!ready) return;
    const onLive = $route.page === 'live';
    const seconds = $preferences?.liveKeepAlive ?? 60;
    if (onLive) {
      liveMounted = true;
      leftWith = null;
      keepAlive.enter();
    } else if (wasLive || (liveMounted && leftWith !== null && seconds !== leftWith)) {
      // Just left Live, or the keep-alive preference changed while away
      // (restart the countdown with the new time; "off" stops at once).
      leftWith = seconds;
      keepAlive.leave(seconds);
    }
    wasLive = onLive;
  });
  $effect(() => () => keepAlive.dispose());

  async function load() {
    try {
      const [profile, list, prefs] = await Promise.all([getJson<Me>('/api/me'), getJson<CameraSummary[]>('/api/cameras'), loadPreferences()]);
      me.set(profile);
      cameras.set(list);
      selectedCameraId.update((id) =>
        list.some((c) => c.id === id)
          ? id
          : (prefs?.defaultCamera && list.some((c) => c.id === prefs.defaultCamera) ? prefs.defaultCamera : (list[0]?.id ?? null)),
      );
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) loadError = 'Could not load the app. Please reload the page.';
    } finally {
      ready = true;
    }
  }

  onMount(() => {
    theme.set(currentTheme());
    const stop = initRouter();
    void load();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') drawerOpen.set(false); };
    addEventListener('keydown', onKey);
    return () => { stop(); removeEventListener('keydown', onKey); };
  });

  // Move focus into the drawer when it opens, and back to the hamburger
  // button when it closes (Escape, backdrop, close button or navigation).
  $effect(() => {
    const isOpen = $drawerOpen;
    if (isOpen && !drawerWasOpen) {
      drawerPanelEl?.querySelector<HTMLElement>('[data-testid^="nav-"]')?.focus();
    } else if (!isOpen && drawerWasOpen) {
      document.querySelector<HTMLElement>('[data-testid="hamburger"]')?.focus();
    }
    drawerWasOpen = isOpen;
  });
</script>

<div class="shell">
  <TopBar />
  <div class="side"><Sidebar /></div>
  <main class="main">
    {#if loadError}<div class="error" role="alert">{loadError}</div>{/if}
    {#if ready}
      <!-- Outside the {#key} below: a route change must not remount Live. -->
      {#if liveMounted}
        <div class="live-host" hidden={$route.page !== 'live'} in:fly={{ y: 8, duration: duration(180) }}><Live visible={$route.page === 'live'} /></div>
      {/if}
      {#if $route.page !== 'live'}
        {#key $route.page}
          <div class="page-wrap" in:fly={{ y: 8, duration: duration(180) }}>
            {#if $route.page === 'recordings'}<Recordings />
            {:else if $route.page === 'settings'}<Settings />
            {:else if $route.page === 'about'}<About />{/if}
          </div>
        {/key}
      {/if}
    {/if}
  </main>

  {#if $drawerOpen}
    <button class="backdrop" aria-label="Close menu" transition:fade={{ duration: duration(150) }} onclick={() => drawerOpen.set(false)}></button>
    <div
      class="drawer-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      bind:this={drawerPanelEl}
      transition:fly={{ x: -280, duration: duration(220) }}
    >
      <button class="close" aria-label="Close menu" onclick={() => drawerOpen.set(false)}><Icon name="close" /></button>
      <Sidebar drawer />
    </div>
  {/if}
</div>

<style>
  .shell {
    height: 100vh; display: grid;
    grid-template-columns: auto 1fr; grid-template-rows: auto 1fr;
    grid-template-areas: 'top top' 'side main';
  }
  .side { grid-area: side; min-height: 0; }
  .main { grid-area: main; overflow: auto; padding: 24px 28px; min-width: 0; }
  :global(.page h1) { margin: 0 0 16px; font-size: 24px; letter-spacing: -0.01em; }
  :global(.placeholder), :global(.card) {
    padding: 28px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border);
    color: var(--muted); box-shadow: var(--shadow);
  }
  .error { padding: 12px 16px; margin-bottom: 16px; border-radius: 10px; background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--text); }
  .backdrop { position: fixed; inset: 0; background: var(--scrim); border: 0; z-index: 30; }
  .drawer-panel { position: fixed; top: 0; bottom: 0; left: 0; z-index: 31; background: var(--chrome); box-shadow: var(--shadow); padding-top: 48px; }
  .close { position: absolute; top: 10px; right: 10px; width: 36px; height: 36px; display: grid; place-items: center; border: 0; background: transparent; cursor: pointer; }
  @media (max-width: 767px) {
    .shell { grid-template-columns: 1fr; grid-template-areas: 'top' 'main'; }
    .side { display: none; }
    .main { padding: 16px; }
  }
</style>
