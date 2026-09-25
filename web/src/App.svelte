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
  import { duration } from './lib/motion';
  import { currentTheme } from './lib/theme';

  let loadError = $state('');
  let drawerPanelEl: HTMLDivElement | undefined = $state();
  let drawerWasOpen = false;

  async function load() {
    try {
      const [profile, list] = await Promise.all([getJson<Me>('/api/me'), getJson<CameraSummary[]>('/api/cameras')]);
      me.set(profile);
      cameras.set(list);
      selectedCameraId.update((id) => (list.some((c) => c.id === id) ? id : (list[0]?.id ?? null)));
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) loadError = 'Could not load the app. Please reload the page.';
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
    {#key $route.page}
      <div class="page-wrap" in:fly={{ y: 8, duration: duration(180) }}>
        {#if $route.page === 'recordings'}<Recordings />
        {:else if $route.page === 'settings'}<Settings />
        {:else if $route.page === 'about'}<About />
        {:else}<Live />{/if}
      </div>
    {/key}
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
