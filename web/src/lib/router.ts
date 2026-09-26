import { writable, type Readable } from 'svelte/store';
import type { IconName } from './icons';

export type Page = 'live' | 'recordings' | 'settings' | 'about';
export type Panel = 'history' | 'events' | 'downloads';

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
}

const PAGES: Page[] = ['live', 'recordings', 'settings', 'about'];
const PANELS: Panel[] = ['history', 'events', 'downloads'];

export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const segment = pathname.replace(/^\/app\/?/, '').split('/')[0];
  const page = (PAGES as string[]).includes(segment) ? (segment as Page) : 'live';
  const rawPanel = params.get('panel') ?? '';
  const panel = (PANELS as string[]).includes(rawPanel) ? (rawPanel as Panel) : 'history';
  return { page, panel, params };
}

// History, Events and Downloads are three doors into one Recordings
// workspace; the panel decides which side panel is open.
export const NAV_ITEMS: NavItem[] = [
  { id: 'live', label: 'Live', icon: 'live', href: '/app/live', page: 'live' },
  { id: 'history', label: 'History', icon: 'history', href: '/app/recordings?panel=history', page: 'recordings', panel: 'history' },
  { id: 'events', label: 'Events', icon: 'events', href: '/app/recordings?panel=events', page: 'recordings', panel: 'events' },
  { id: 'downloads', label: 'Downloads', icon: 'downloads', href: '/app/recordings?panel=downloads', page: 'recordings', panel: 'downloads' },
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
