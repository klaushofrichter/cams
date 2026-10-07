// The session's account and role in the web app (migration P4, M §9.5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_SESSION_KEYS, clearCameraSessionState, isAdmin, switchAccount } from './session';

const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
let assigned: string[] = [];
let calls: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  store.clear();
  assigned = [];
  calls = [];
  vi.stubGlobal('sessionStorage', fakeStorage);
  vi.stubGlobal('location', { assign: (u: string) => assigned.push(u), pathname: '/app/accounts', search: '', hash: '' });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ redirect: '/app/video' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('session', () => {
  it('isAdmin: only role admin', () => {
    expect(isAdmin({ email: 'a', version: '', buildDate: null, role: 'admin' })).toBe(true);
    expect(isAdmin({ email: 'a', version: '', buildDate: null, role: 'viewer' })).toBe(false);
    expect(isAdmin(null)).toBe(false);
    // an older server without roles: everyone admin (file mode)
    expect(isAdmin({ email: 'a', version: '', buildDate: null })).toBe(true);
  });

  it('switchAccount posts, clears the cursor and the view point, then loads the redirect', async () => {
    store.set('cams-cursor', '{"cam":"cam1"}');
    store.set('cams.viewPoint', '{"cam":"cam1"}');
    store.set('other', 'kept');
    await switchAccount('acc_B');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/session/account');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ accountId: 'acc_B' });
    expect(store.has('cams-cursor')).toBe(false);
    expect(store.has('cams.viewPoint')).toBe(false);
    expect(store.get('other')).toBe('kept');
    expect(assigned).toEqual(['/app/video']);
  });

  it('clearCameraSessionState covers the keys of recordings.ts and timeline.ts', () => {
    expect([...CAMERA_SESSION_KEYS].sort()).toEqual(['cams-cursor', 'cams.viewPoint']);
    store.set('cams-cursor', 'x');
    clearCameraSessionState();
    expect(store.size).toBe(0);
  });
});

describe('showsAdminControls', () => {
  it('unknown → as before; a viewer → no', async () => {
    const { showsAdminControls } = await import('./session');
    expect(showsAdminControls(null)).toBe(true);
    expect(showsAdminControls({ email: 'a', version: '', buildDate: null, role: 'viewer' })).toBe(false);
    expect(showsAdminControls({ email: 'a', version: '', buildDate: null, role: 'admin' })).toBe(true);
  });
});
