// web/src/lib/zoomPref.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { pickZoom, zoom } from './zoomPref';
import { preferences, type Preferences } from './preferences';

const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60 };
afterEach(() => {
  vi.unstubAllGlobals();
  preferences.set(null);
});

describe('zoomPref', () => {
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
});
