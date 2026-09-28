import { derived, get, writable } from 'svelte/store';
import { getJson } from './api';
import { putJson } from './settings';

export interface Preferences {
  defaultCamera: string | null; // null: the last camera used
  lastCamera?: string | null;
  liveQuality: 'sub' | 'main';
  eventFilter: 'all' | 'person' | 'vehicle' | 'pet' | 'motion';
  timelineZoom: 24 | 12 | 6 | 3 | 1;
  liveKeepAlive: 0 | 30 | 60 | 120 | 300 | 900;
  liveEvents?: boolean; // new events at once, with a notification (default on)
  liveEventTypes?: ('person' | 'vehicle' | 'pet' | 'motion')[]; // which ones notify
}

export const preferences = writable<Preferences | null>(null);
// Distinguishes "still loading" (both null, false) from "failed to load"
// (preferences null, this true), so a page waiting on preferences can show
// an error instead of "Loading…" forever.
export const preferencesFailed = writable(false);

export async function loadPreferences(): Promise<Preferences | null> {
  try {
    const p = await getJson<Preferences>('/api/preferences');
    preferences.set(p);
    preferencesFailed.set(false);
    return p;
  } catch {
    preferencesFailed.set(true);
    return null; // preferences are a convenience; the app works without them
  }
}

export async function savePreferences(patch: Partial<Preferences>): Promise<boolean> {
  const res = await putJson<Preferences>('/api/preferences', patch);
  if (res.status !== 200) return false;
  preferences.set(res.body);
  return true;
}

// The camera the app opens on: the chosen default, else the last camera
// used, else the first (Klaus, 2026-09-28).
export function startCamera(list: { id: string }[], p: Pick<Preferences, 'defaultCamera' | 'lastCamera'> | null): string | null {
  const known = (id: string | null | undefined) => (id && list.some((c) => c.id === id) ? id : null);
  return known(p?.defaultCamera) ?? known(p?.lastCamera) ?? list[0]?.id ?? null;
}

// Remembered on every switch, so the next visit (any device) opens on it.
export function rememberCamera(id: string): void {
  const p = get(preferences);
  if (!p || p.lastCamera === id) return;
  preferences.update((x) => (x ? { ...x, lastCamera: id } : x));
  void savePreferences({ lastCamera: id }).catch(() => undefined);
}

// Whether live events are on: changes only when the setting does (not on
// every preferences write, such as the zoom or the last camera).
export const liveEventsOn = derived(preferences, (p) => p?.liveEvents !== false);

export const pref = <K extends keyof Preferences>(k: K): Preferences[K] | undefined => get(preferences)?.[k];
