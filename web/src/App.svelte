<script lang="ts">
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Icon from './components/Icon.svelte';
  import Video from './pages/Video.svelte';
  import Timeline from './pages/Timeline.svelte';
  import Archive from './pages/Archive.svelte';
  import Settings from './pages/Settings.svelte';
  import About from './pages/About.svelte';
  import Accounts from './pages/Accounts.svelte';
  import HeldBanner from './components/HeldBanner.svelte';
  import StaleBanner from './components/StaleBanner.svelte';
  import { initRouter, route } from './lib/router';
  import { cameras, drawerOpen, me, selectedCameraId, sidebarCollapsed, theme, type CameraSummary, type Me } from './lib/stores';
  import { getJson, UnauthorizedError, watchMediaErrors } from './lib/api';
  import { loadPreferences, preferences, rememberCamera, startCamera } from './lib/preferences';
  import { liveStreamHeld } from './lib/liveUi';
  import { duration } from './lib/motion';
  import { currentTheme } from './lib/theme';
  import { liveStatus, documentTitle } from './lib/liveStatus';
  import { setFavicon } from './lib/favicon';

  let loadError = $state('');
  // Preferences (and the default-camera selection derived from them) must
  // settle before any page mounts, so a page that reads a preference at
  // init (Live's initialQuality, Timeline's initial zoom) sees the real
  // value instead of racing it. This gate covers success and failure
  // alike -- a failed preferences load still finishes `load()`.
  let ready = $state(false);
  let drawerPanelEl: HTMLDivElement | undefined = $state();
  let drawerWasOpen = false;

  // The video page (Live and History) stays mounted but hidden
  // while it holds the live stream for the keep-alive after the user left
  // (spec 2026-09-28); the page runs that countdown itself. When it lets go,
  // the page unmounts and the stream closes. The page's <video> is never
  // moved in the DOM: removing a media element pauses it.
  // "On screen" also needs the browser tab visible: a hidden tab or
  // minimised window is off-screen too (Klaus, 2026-09-26).
  let tabVisible = $state(typeof document === 'undefined' || document.visibilityState !== 'hidden');
  $effect(() => {
    const onVisibility = () => (tabVisible = document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });
  const videoMounted = $derived($route.page === 'video' || $liveStreamHeld);

  // The favicon frame and tab title mirror the camera's live status (Task
  // 13). Signing out is a full page navigation (to a separate entry point,
  // web/src/landing.ts), which already resets both to their shipped values.
  $effect(() => {
    setFavicon($liveStatus.state);
    document.title = documentTitle($liveStatus);
  });

  async function load() {
    try {
      const [profile, list, prefs] = await Promise.all([getJson<Me>('/api/me'), getJson<CameraSummary[]>('/api/cameras'), loadPreferences()]);
      me.set(profile);
      cameras.set(list);
      selectedCameraId.update((id) => (list.some((c) => c.id === id) ? id : startCamera(list, prefs)));
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) loadError = 'Could not load the app. Please reload the page.';
    } finally {
      ready = true;
    }
  }

  // Remember the camera on every switch (the default when none is chosen).
  $effect(() => {
    const id = $selectedCameraId;
    if (ready && id) rememberCamera(id);
  });

  onMount(() => {
    theme.set(currentTheme());
    const stop = initRouter();
    // A failed /api image or video may be an expired session (see lib/api.ts).
    const unwatch = watchMediaErrors();
    void load();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') drawerOpen.set(false); };
    addEventListener('keydown', onKey);
    return () => { stop(); unwatch(); removeEventListener('keydown', onKey); };
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

<!-- The app is as wide as sidebar + video + panel at most; a wider window
     gets equal margins either side, top bar included (Klaus, 2026-09-28). -->
<div class="shell" style={`--sidebar-w: ${$sidebarCollapsed ? 64 : 220}px`}>
  <TopBar />
  <div class="side"><Sidebar /></div>
  <main class="main">
    {#if loadError}<div class="error" role="alert">{loadError}</div>{/if}
    {#if ready && $route.page !== 'accounts'}<StaleBanner /><HeldBanner />{/if}
    {#if ready}
      <!-- Outside the {#key} below: a route change must not remount the video page. -->
      {#if videoMounted}
        <div class="video-host" hidden={$route.page !== 'video'} in:fly={{ y: 8, duration: duration(180) }}><Video pageVisible={$route.page === 'video'} {tabVisible} /></div>
      {/if}
      {#if $route.page !== 'video'}
        {#key $route.page}
          <div class="page-wrap" in:fly={{ y: 8, duration: duration(180) }}>
            {#if $route.page === 'timeline'}<Timeline />
            {:else if $route.page === 'archive'}<Archive />
            {:else if $route.page === 'settings'}<Settings />
            {:else if $route.page === 'about'}<About />
            {:else if $route.page === 'accounts'}<Accounts />{/if}
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
    /* sidebar (+1 px border), the page's 28 px padding either side, the
       player, the 18 px gap and the 340 px panel */
    --app-max-w: calc(var(--sidebar-w) + 1px + 56px + var(--player-max-w) + 18px + 340px);
    max-width: var(--app-max-w); margin: 0 auto; box-shadow: 0 0 0 1px var(--border);
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
    .shell { max-width: none; box-shadow: none; grid-template-columns: 1fr; grid-template-areas: 'top' 'main'; }
    .side { display: none; }
    .main { padding: 16px; }
  }
</style>
