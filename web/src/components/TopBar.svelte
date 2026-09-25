<script lang="ts">
  import Logo from './Logo.svelte';
  import Icon from './Icon.svelte';
  import CameraPicker from './CameraPicker.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import { me, drawerOpen } from '../lib/stores';

  const REPO_URL = 'https://github.com/klaushofrichter/cams';
</script>

<header class="topbar" data-testid="topbar">
  <button class="hamburger" data-testid="hamburger" aria-label="Open menu" aria-expanded={$drawerOpen} onclick={() => drawerOpen.set(true)}>
    <Icon name="menu" />
  </button>
  <a class="brand" href="/app/live" aria-label="cams home"><Logo size={28} /><span>cams</span></a>
  <CameraPicker />
  <div class="spacer"></div>
  {#if $me}
    <a class="version" data-testid="version-link" href={REPO_URL} target="_blank" rel="noopener noreferrer" title="cams on GitHub">{$me.version}</a>
  {/if}
  <div class="desktop-only"><ThemeToggle /></div>
  <a class="logout desktop-only" data-testid="logout" href="/auth/logout"><Icon name="logout" size={18} /><span>Logout</span></a>
</header>

<style>
  .topbar {
    grid-area: top; display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    background: var(--chrome); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20;
  }
  .brand { display: flex; align-items: center; gap: 9px; color: var(--text); text-decoration: none; font-weight: 700; font-size: 17px; letter-spacing: 0.01em; }
  .spacer { flex: 1; }
  .version {
    font-family: var(--mono); font-size: 12px; color: var(--muted); text-decoration: none; opacity: 0.6;
    transition: opacity 0.15s ease, color 0.15s ease;
  }
  .version:hover { opacity: 1; color: var(--accent); text-decoration: underline; }
  .logout {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 10px;
    background: var(--grad); color: var(--on-grad); font-weight: 600; font-size: 14px; text-decoration: none;
    transition: filter 0.15s ease, transform 0.15s ease;
  }
  .logout:hover { filter: brightness(1.1); transform: translateY(-1px); }
  .hamburger { display: none; width: 36px; height: 36px; place-items: center; border: 0; background: transparent; cursor: pointer; border-radius: 10px; }
  @media (max-width: 767px) {
    .hamburger { display: grid; }
    .desktop-only { display: none; }
    .brand span { display: none; }
  }
</style>
