// web/src/lib/eventFilter.ts
import { derived, get, type Readable } from 'svelte/store';
import { preferences, savePreferences } from './preferences';
import { filterParam, parseFilter, type Filter } from './recordings';

// The event filter (Person / Vehicle / Pet / Motion) is one preference,
// `eventFilter`, for History and Live alike (Klaus, 2026-10-03): a chip on
// either changes both, and it survives page switches and reloads (and is
// the default on Settings). Null until the preferences have loaded.
export const eventFilter: Readable<Filter | null> = derived(preferences, (p) => (p ? parseFilter(p.eventFilter) : null));

let chain: Promise<unknown> = Promise.resolve();
let latest: Filter | null = null;

// A pick applies at once and is saved; saves go one after another and the
// store ends with the last pick, whatever order the answers arrive in (as
// the strip's zoom, zoomPref.ts). A failed save keeps the pick on screen.
export function pickEventFilter(f: Filter): Promise<void> {
  const want = parseFilter(f);
  latest = want;
  preferences.update((p) => (p ? { ...p, eventFilter: want } : p));
  const run = chain.then(async () => {
    await savePreferences({ eventFilter: want }).catch(() => false);
    const last = latest;
    if (last && filterParam(parseFilter(get(preferences)?.eventFilter)) !== filterParam(last)) preferences.update((p) => (p ? { ...p, eventFilter: last } : p));
  });
  chain = run.catch(() => undefined);
  return run;
}
