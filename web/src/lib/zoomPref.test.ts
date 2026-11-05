// web/src/lib/zoomPref.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { pickZoom, setLinkZoom, withValidZoom, zoom } from './zoomPref';
import { preferences, type Preferences } from './preferences';

const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60 };
afterEach(() => {
  vi.unstubAllGlobals();
  preferences.set(null);
  setLinkZoom(null);
});

describe('zoomPref', () => {
  it('gives a preferences object a zoom the strip offers (Settings\' draft)', () => {
    expect(withValidZoom({ ...PREFS, timelineZoom: 12 })).toEqual({ ...PREFS, timelineZoom: 6 });
    expect(withValidZoom({ ...PREFS, timelineZoom: 1 / 6 })).toEqual({ ...PREFS, timelineZoom: 1 / 6 });
  });

  it('follows the saved preference, 24 until it loads', () => {
    expect(get(zoom)).toBe(24);
    preferences.set({ ...PREFS, timelineZoom: 3 });
    expect(get(zoom)).toBe(3);
    preferences.set({ ...PREFS, timelineZoom: 12 as Preferences['timelineZoom'] }); // saved before 12 h went (2026-10-04)
    expect(get(zoom)).toBe(6);
  });

  it('saves picks one after another; the last pick wins', async () => {
    const sent: number[] = [];
    const answers: (() => void)[] = [];
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => {
      const z = JSON.parse(String(init.body)).timelineZoom;
      sent.push(z);
      return new Promise<Response>((r) => answers.push(() => r(new Response(JSON.stringify({ ...PREFS, timelineZoom: z }), { status: 200 }))));
    });
    preferences.set(PREFS);
    const a = pickZoom(12);
    const b = pickZoom(3);
    expect(get(zoom)).toBe(3); // optimistic
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([12]);
    answers[0]();
    await a;
    expect(get(zoom)).toBe(3); // the older answer doesn't win
    await new Promise((r) => setTimeout(r, 0));
    answers[1]();
    await b;
    expect(sent).toEqual([12, 3]);
    expect(get(zoom)).toBe(3);
  });

  // A link's interval wins over the preference (Klaus, 2026-11-05).
  it('shows a link\'s zoom over the preference, without saving it', () => {
    preferences.set({ ...PREFS, timelineZoom: 24 });
    setLinkZoom(1);
    expect(get(zoom)).toBe(1);
    expect(get(preferences)?.timelineZoom).toBe(24);
    setLinkZoom(null);
    expect(get(zoom)).toBe(24);
  });

  it('keeps the link\'s zoom while the preferences load and other preferences change', () => {
    setLinkZoom(1 / 6);
    preferences.set({ ...PREFS, timelineZoom: 24 });
    expect(get(zoom)).toBe(1 / 6);
    preferences.set({ ...PREFS, timelineZoom: 24, liveKeepAlive: 30 });
    expect(get(zoom)).toBe(1 / 6);
  });

  it('a changed zoom preference (Settings, a zoom button) replaces the link\'s', () => {
    preferences.set({ ...PREFS, timelineZoom: 24 });
    setLinkZoom(1);
    preferences.set({ ...PREFS, timelineZoom: 3 });
    expect(get(zoom)).toBe(3);
  });

  it('a zoom picked while a link\'s is shown is the one shown', () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ ...PREFS, timelineZoom: 0.5 }), { status: 200 })));
    preferences.set({ ...PREFS, timelineZoom: 24 });
    setLinkZoom(1);
    void pickZoom(0.5);
    expect(get(zoom)).toBe(0.5);
  });

  it('a pick of the preference\'s own zoom still replaces the link\'s', () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(PREFS), { status: 200 })));
    preferences.set({ ...PREFS, timelineZoom: 24 });
    setLinkZoom(1);
    void pickZoom(24);
    expect(get(zoom)).toBe(24);
  });
});
