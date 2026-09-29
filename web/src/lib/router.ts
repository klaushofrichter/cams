import { writable, type Readable } from 'svelte/store';
import type { IconName } from './icons';

// Live and History are one video page; the panel says which (spec
// 2026-09-28). The URLs stay: /app/live and /app/recordings.
export type Page = 'video' | 'timeline' | 'settings' | 'about';
export type Panel = 'live' | 'history';

export interface Route {
  page: Page;
  panel: Panel;
  params: URLSearchParams;
}

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  page: Page;
  panel?: Panel;
  needsProxy?: boolean; // shown only when some camera has a cam-proxy
}

const OTHER_PAGES: Page[] = ['timeline', 'settings', 'about'];

export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const segment = pathname.replace(/^\/app\/?/, '').split('/')[0];
  if ((OTHER_PAGES as string[]).includes(segment)) return { page: segment as Page, panel: 'live', params };
  // Anything unknown is Live, never a blank shell.
  if (segment !== 'recordings') return { page: 'video', panel: 'live', params };
  // 'events' (2026-09-28) and 'downloads' (2026-09-29) were more doors to the
  // same list; both are History now, where each card has a download button (Klaus).
  return { page: 'video', panel: 'history', params };
}

// Live and History are two doors into one video page; the panel decides
// which side panel is open.
export const NAV_ITEMS: NavItem[] = [
  { id: 'live', label: 'Live', icon: 'live', href: '/app/live', page: 'video', panel: 'live' },
  { id: 'history', label: 'History', icon: 'history', href: '/app/recordings?panel=history', page: 'video', panel: 'history' },
  { id: 'timeline', label: 'Timeline', icon: 'timeline', href: '/app/timeline', page: 'timeline', needsProxy: true },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '/app/settings', page: 'settings' },
  { id: 'about', label: 'About', icon: 'about', href: '/app/about', page: 'about' },
];

export function isActive(item: NavItem, route: Route): boolean {
  if (item.page !== route.page) return false;
  return item.panel === undefined || item.panel === route.panel;
}

const store = writable<Route>(parseRoute('/app/live', ''));
export const route: Readable<Route> = { subscribe: store.subscribe };

function sync(): void {
  store.set(parseRoute(location.pathname, location.search));
}

export function navigate(href: string): void {
  if (href === location.pathname + location.search) return;
  history.pushState({}, '', href);
  sync();
}

// Auto-advance and cursor restoration replace the current history entry
// instead of pushing a new one, so the back button doesn't have to step
// through every clip or re-play a stale restore.
export function replaceRoute(href: string): void {
  if (href === location.pathname + location.search) return;
  history.replaceState({}, '', href);
  sync();
}

export function initRouter(): () => void {
  sync();
  addEventListener('popstate', sync);
  return () => removeEventListener('popstate', sync);
}
