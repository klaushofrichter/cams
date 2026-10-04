// web/src/lib/eventFilter.test.ts
// @vitest-environment jsdom
// The event filter is one preference for History and Live (Klaus, 2026-10-03).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { eventFilter, pickEventFilter } from './eventFilter';
import { preferences, type Preferences } from './preferences';

const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60 };
afterEach(() => {
  vi.unstubAllGlobals();
  preferences.set(null);
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('eventFilter', () => {
  it('is the saved preference, null until it loads', () => {
    expect(get(eventFilter)).toBeNull();
    preferences.set({ ...PREFS, eventFilter: ['vehicle', 'person'] });
    expect(get(eventFilter)).toEqual(['person', 'vehicle']); // in chip order
    preferences.set({ ...PREFS, eventFilter: 'pet' as unknown as Preferences['eventFilter'] }); // an older single value
    expect(get(eventFilter)).toEqual(['pet']);
  });

  it('a pick applies at once for every reader and is saved; the last pick wins', async () => {
    const sent: unknown[] = [];
    const answers: (() => void)[] = [];
    vi.stubGlobal('fetch', (u: string, init: RequestInit) => {
      expect(u).toBe('/api/preferences');
      expect(init.method).toBe('PUT');
      const body = JSON.parse(String(init.body));
      sent.push(body);
      return new Promise<Response>((r) => answers.push(() => r(new Response(JSON.stringify({ ...PREFS, ...body }), { status: 200 }))));
    });
    preferences.set(PREFS);
    const seen: unknown[] = [];
    const stop = eventFilter.subscribe((f) => seen.push(f));
    const a = pickEventFilter(['person']);
    const b = pickEventFilter(['person', 'pet']);
    expect(get(eventFilter)).toEqual(['person', 'pet']); // optimistic
    expect(get(preferences)!.eventFilter).toEqual(['person', 'pet']); // the same store, not a copy
    await flush();
    expect(sent).toEqual([{ eventFilter: ['person'] }]);
    answers[0]();
    await a;
    expect(get(eventFilter)).toEqual(['person', 'pet']); // the older answer doesn't win
    await flush();
    answers[1]();
    await b;
    expect(sent).toEqual([{ eventFilter: ['person'] }, { eventFilter: ['person', 'pet'] }]);
    expect(get(eventFilter)).toEqual(['person', 'pet']);
    expect(seen[0]).toEqual(PREFS.eventFilter);
    stop();
  });

  it('a pick before the preferences loaded is saved and fills them in', async () => {
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => Promise.resolve(new Response(JSON.stringify({ ...PREFS, ...JSON.parse(String(init.body)) }), { status: 200 })));
    await pickEventFilter(['motion']);
    expect(get(eventFilter)).toEqual(['motion']);
  });

  it('a failed save keeps the pick on screen', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    preferences.set(PREFS);
    await pickEventFilter(['vehicle']);
    expect(get(eventFilter)).toEqual(['vehicle']);
  });
});
