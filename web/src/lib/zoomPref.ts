// web/src/lib/zoomPref.ts
import { derived, get, type Readable } from 'svelte/store';
import { preferences, savePreferences } from './preferences';
import { normalizeZoom, type StripZoom } from './strip';

// The History strip's zoom is the saved preference (Klaus, 2026-09-27): a
// pick applies at once and is saved; saves go one after another and the
// store ends with the last pick, whatever order the answers arrive in.
export const zoom: Readable<StripZoom> = derived(preferences, (p) => normalizeZoom(p?.timelineZoom ?? 24)); // a saved 12 h reads as 6 h

let chain: Promise<unknown> = Promise.resolve();
let latest: StripZoom | null = null;

export function pickZoom(z: StripZoom): Promise<void> {
  latest = z;
  preferences.update((p) => (p ? { ...p, timelineZoom: z } : p));
  const run = chain.then(async () => {
    await savePreferences({ timelineZoom: z }).catch(() => false);
    if (latest !== null && get(preferences)?.timelineZoom !== latest) preferences.update((p) => (p ? { ...p, timelineZoom: latest! } : p));
  });
  chain = run.catch(() => undefined);
  return run;
}
