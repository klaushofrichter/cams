import { get, writable } from 'svelte/store';
import { getJson } from './api';
import { putJson } from './settings';

export interface Preferences {
  defaultCamera: string | null;
  liveQuality: 'sub' | 'main';
  eventFilter: 'all' | 'person' | 'vehicle' | 'pet' | 'motion';
  timelineZoom: 24 | 6 | 1;
  liveKeepAlive: 0 | 30 | 60 | 120 | 300 | 900;
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

export const pref = <K extends keyof Preferences>(k: K): Preferences[K] | undefined => get(preferences)?.[k];
