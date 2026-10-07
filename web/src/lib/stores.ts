import { derived, writable, type Writable } from 'svelte/store';
import type { Theme } from './theme';

export interface Me {
  email: string;
  version: string;
  buildDate: string | null;
  // Migration P4 (cams-admin): the session's account and role; file mode is one account, admin.
  account?: { id: string; name: string; displayName: string } | null;
  role?: 'admin' | 'viewer' | null;
  accounts?: number;
  configSource?: 'file' | 'shadow' | 'cams-admin';
  staleSince?: number | null; // admins: no configuration pulled since then (24 h+)
  configProblem?: 'revoked' | 'unknown_key' | 'snapshot_older' | 'file_account_changed' | null; // admins: cams-admin refuses this instance, an older snapshot, the home account under another id
  held?: number; // admins: held connection changes waiting
}

export interface CameraSummary {
  id: string;
  name: string;
  webUiUrl: string | null;
  webUiNote?: string;
  proxy?: boolean; // cams uses the camera's cam-proxy now (Plan 6); absent in old test fixtures
  proxyConfigured?: boolean; // the camera has a cam-proxy at all (the switch on Settings)
  credentials?: 'missing' | 'mismatch' | 'unconfirmed'; // cams-admin mode: no usable camera password here, or held as new
}

// A boolean kept in localStorage. Storage failures (private mode) degrade to
// an in-memory value rather than breaking the page.
export function persistedBoolean(key: string, initial: boolean): Writable<boolean> {
  let start = initial;
  try {
    const stored = localStorage.getItem(key);
    if (stored === '1' || stored === '0') start = stored === '1';
  } catch {
    // keep initial
  }
  const store = writable(start);
  store.subscribe((value) => {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      // not persisted this session
    }
  });
  return store;
}

export const sidebarCollapsed = persistedBoolean('cams-sidebar-collapsed', false);
export const drawerOpen = writable(false);
export const me = writable<Me | null>(null);
export const cameras = writable<CameraSummary[]>([]);
// A camera of the list by id (undefined: none).
export const cameraById = derived(cameras, (list) => (id: string | null | undefined) => list.find((c) => c.id === id));
export const selectedCameraId = writable<string | null>(null);
export const theme = writable<Theme>('dark');
