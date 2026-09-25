import { writable, type Writable } from 'svelte/store';

export interface Me {
  email: string;
  version: string;
}

export interface CameraSummary {
  id: string;
  name: string;
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
export const selectedCameraId = writable<string | null>(null);
