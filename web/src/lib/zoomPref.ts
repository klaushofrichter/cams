// web/src/lib/zoomPref.ts
import { derived, get, writable, type Readable } from 'svelte/store';
import { preferences, savePreferences, type Preferences } from './preferences';
import { normalizeZoom, type StripZoom } from './strip';

// The History strip's zoom is the saved preference (Klaus, 2026-09-27): a
// pick applies at once and is saved; saves go one after another and the
// store ends with the last pick, whatever order the answers arrive in.
// A Video link's zoom (`zoom=`, Klaus 2026-11-05) wins over the preference
// without saving it, until the zoom preference changes (a zoom button, Settings).
const linkZoom = writable<StripZoom | null>(null);
export const setLinkZoom = (z: StripZoom | null): void => linkZoom.set(z);
let prefZoom: StripZoom | null = null; // the preference's zoom, once loaded
preferences.subscribe((p) => {
  const z = p ? normalizeZoom(p.timelineZoom) : null;
  if (prefZoom !== null && z !== null && z !== prefZoom) linkZoom.set(null);
  prefZoom = z;
});
export const zoom: Readable<StripZoom> = derived([preferences, linkZoom], ([p, l]) => l ?? normalizeZoom(p?.timelineZoom ?? 24)); // a saved 12 h reads as 6 h

// Settings' draft: a stored zoom the strip no longer offers (12 h) as the
// one it reads as, so the dropdown isn't blank and nothing looks edited.
export const withValidZoom = <P extends Preferences>(p: P): P => ({ ...p, timelineZoom: normalizeZoom(p.timelineZoom) });

let chain: Promise<unknown> = Promise.resolve();
let latest: StripZoom | null = null;

export function pickZoom(z: StripZoom): Promise<void> {
  latest = z;
  linkZoom.set(null);
  preferences.update((p) => (p ? { ...p, timelineZoom: z } : p));
  const run = chain.then(async () => {
    await savePreferences({ timelineZoom: z }).catch(() => false);
    if (latest !== null && get(preferences)?.timelineZoom !== latest) preferences.update((p) => (p ? { ...p, timelineZoom: latest! } : p));
  });
  chain = run.catch(() => undefined);
  return run;
}
