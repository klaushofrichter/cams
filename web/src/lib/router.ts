import { writable, type Readable } from 'svelte/store';
import type { IconName } from './icons';

// One Video page (spec 2026-10-04): the player decides between live and a
// recording; the URL only says which to open. `panel` is that request:
// 'live' (at now) or 'history' (a recording). /app/live and /app/recordings
// still work (`legacy`): the page rewrites them to /app/video.
export type Page = 'video' | 'timeline' | 'archive' | 'settings' | 'about' | 'accounts';
export type Panel = 'live' | 'history';

export const VIDEO_PATH = '/app/video';

export interface Route {
  page: Page;
  panel: Panel;
  params: URLSearchParams;
  legacy: boolean; // a video URL other than /app/video
}

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  page: Page;
  needsProxy?: boolean; // shown only when some camera has a cam-proxy
}

// 'accounts': the account picker (migration P4), reached from sign-in and the menu.
const OTHER_PAGES: Page[] = ['timeline', 'archive', 'settings', 'about', 'accounts'];

export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const segment = pathname.replace(/^\/app\/?/, '').split('/')[0];
  if ((OTHER_PAGES as string[]).includes(segment)) return { page: segment as Page, panel: 'live', params, legacy: false };
  const positioned = params.has('at') || params.has('date') || params.has('clip');
  // History, Events (2026-09-28) and Downloads (2026-09-29) links: a recording.
  if (segment === 'recordings') return { page: 'video', panel: 'history', params, legacy: pathname !== VIDEO_PATH };
  // An old /app/live?at= link (earlier versions wrote them) is a recording too.
  if (segment === 'live') return { page: 'video', panel: params.has('at') ? 'history' : 'live', params, legacy: true };
  // Anything unknown is the video page, never a blank shell.
  return { page: 'video', panel: positioned && segment === 'video' ? 'history' : 'live', params, legacy: pathname !== VIDEO_PATH };
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'video', label: 'Video', icon: 'live', href: VIDEO_PATH, page: 'video' },
  { id: 'timeline', label: 'Timeline', icon: 'timeline', href: '/app/timeline', page: 'timeline', needsProxy: true },
  // The cam-proxies' Archive (cams spec 2026-10-05-archive-design).
  { id: 'archive', label: 'Archive', icon: 'archive', href: '/app/archive', page: 'archive', needsProxy: true },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '/app/settings', page: 'settings' },
  { id: 'about', label: 'About', icon: 'about', href: '/app/about', page: 'about' },
];

export function isActive(item: NavItem, route: Route): boolean {
  return item.page === route.page;
}

const store = writable<Route>(parseRoute(VIDEO_PATH, ''));
export const route: Readable<Route> = { subscribe: store.subscribe };

// The URL the route was last read from (the page shows it).
let shown = '';
function sync(): void {
  shown = location.pathname + location.search;
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
  // The entry's state stays (fill-the-screen marks its entry, see guardBack).
  history.replaceState(history.state, '', href);
  sync();
}

// A Back that only leaves something on screen (the player's fill-the-screen
// mode, spec 2026-10-04-fullscreen-recorded): the guard returns true to take
// it, and the URL stays what is shown (the entry below may hold an older
// position). One guard at a time.
let backGuard: (() => boolean) | null = null;
export function guardBack(fn: () => boolean): () => void {
  backGuard = fn;
  return () => {
    if (backGuard === fn) backGuard = null;
  };
}
function onPop(): void {
  if (backGuard?.()) {
    if (location.pathname + location.search !== shown) history.replaceState(history.state, '', shown);
    return;
  }
  sync();
}

export function initRouter(): () => void {
  sync();
  addEventListener('popstate', onPop);
  return () => removeEventListener('popstate', onPop);
}
