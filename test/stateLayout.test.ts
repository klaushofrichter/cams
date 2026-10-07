// Account-keyed state files (migration P4, M §9.6, §11.5, R4-10, R4-15):
// preferences, the proxy switch and the TLS pins keep today's layout in file
// mode, move into an account layout at the first cams-admin start (a .bak
// kept), and file mode reads that layout too (the rollback).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { keyed, setCameras } from '../server/cameraRegistry';
import { camKey, fileAccount, setFleet, type AccountRef } from '../server/fleet';
import { getPreferences, moveToAccounts, savePreferences, validatePreferencesPatch, DEFAULT_PREFERENCES } from '../server/preferences';
import { loadProxyState, moveProxyStateToAccounts, proxyEnabled, setProxyEnabled } from '../server/proxyState';
import { fallbackPin, loadTlsState, moveTlsPinsToAccounts, setFallbackPin } from '../server/tls/store';
import { cacheName } from '../server/recordings/service';
import { backupOnce, entryFor, toAccounts, withEntry } from '../server/stateLayout';
import { ALPHA, ALPHA_REF, BETA, BETA_REF, k, twoAccounts } from './helpers/fleet';

let dir: string, PREFS: string, STATE: string, TLS: string;
const HOME = (): AccountRef => ({ ...fileAccount(), id: 'acc_HOMEHOMEHOMEHOMEHOME' });
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cams-layout-'));
  PREFS = join(dir, 'prefs.json');
  STATE = join(dir, 'proxy-state.json');
  TLS = join(dir, 'proxy-tls.json');
  process.env.PREFS_FILE = PREFS;
  process.env.PROXY_STATE_FILE = STATE;
  process.env.PROXY_TLS_FILE = TLS;
  setCameras([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]);
  loadProxyState();
  loadTlsState();
});
afterEach(() => {
  delete process.env.PROXY_STATE_FILE;
  delete process.env.PROXY_TLS_FILE;
  setCameras([]);
});

describe('layout helpers', () => {
  it('entryFor finds by id, else by name; withEntry re-keys a by-name match to the id', () => {
    const l = { v: 2 as const, accounts: { acc_OLD: { name: 'home', data: 1 }, acc_X: { name: 'x', data: 2 } } };
    expect(entryFor(l, { id: 'acc_X', name: 'other', displayName: '' })).toBe(2);
    expect(entryFor(l, { id: 'acc_NEW', name: 'home', displayName: '' })).toBe(1);
    expect(entryFor(l, { id: 'acc_NONE', name: 'none', displayName: '' })).toBeUndefined();
    expect(withEntry(l, { id: 'acc_NEW', name: 'home', displayName: '' }, 3)).toEqual({ v: 2, accounts: { acc_NEW: { name: 'home', data: 3 }, acc_X: { name: 'x', data: 2 } } });
    expect(toAccounts({ a: 1 }, { id: 'acc_H', name: 'home', displayName: '' })).toEqual({ v: 2, accounts: { acc_H: { name: 'home', data: { a: 1 } } } });
  });

  it('backupOnce copies once, keeping the mode', async () => {
    writeFileSync(TLS, 'one', { mode: 0o600 });
    await backupOnce(TLS);
    writeFileSync(TLS, 'two');
    await backupOnce(TLS);
    expect(readFileSync(`${TLS}.pre-accounts.bak`, 'utf8')).toBe('one');
    expect(statSync(`${TLS}.pre-accounts.bak`).mode & 0o777).toBe(0o600);
  });
});

describe('preferences', () => {
  it('file mode with today\'s files: reads and writes the old layout, byte-compatible', async () => {
    writeFileSync(PREFS, JSON.stringify({ 'a@example.org': { liveQuality: 'main' } }));
    expect((await getPreferences(fileAccount(), 'a@example.org')).liveQuality).toBe('main');
    await savePreferences(fileAccount(), 'b@example.org', { timelineZoom: 6 });
    const all = read(PREFS);
    expect(Object.keys(all).sort()).toEqual(['a@example.org', 'b@example.org']);
    expect(all['b@example.org']).toEqual({ ...DEFAULT_PREFERENCES, timelineZoom: 6 });
  });

  it('moveToAccounts: old → accounts layout under the account, .pre-accounts.bak written once, idempotent', async () => {
    writeFileSync(PREFS, JSON.stringify({ 'a@example.org': { liveQuality: 'main' } }));
    expect(await moveToAccounts(HOME())).toBe(true);
    expect(read(PREFS)).toEqual({ v: 2, accounts: { [HOME().id]: { name: 'home', data: { 'a@example.org': { liveQuality: 'main' } } } } });
    expect(read(`${PREFS}.pre-accounts.bak`)).toEqual({ 'a@example.org': { liveQuality: 'main' } });
    expect(await moveToAccounts(HOME())).toBe(false);
    expect(await moveToAccounts({ ...HOME(), id: 'acc_ELSE' })).toBe(false);
  });

  it('moveToAccounts without a file does nothing', async () => {
    expect(await moveToAccounts(HOME())).toBe(false);
    expect(existsSync(PREFS)).toBe(false);
  });

  it('rollback: file mode on the accounts layout uses the entry named home and keeps the others when it writes (R4-10)', async () => {
    writeFileSync(PREFS, JSON.stringify({ v: 2, accounts: { acc_REAL: { name: 'home', data: { 'a@example.org': { liveQuality: 'main' } } }, [BETA]: { name: 'beta', data: { 'a@example.org': { liveQuality: 'sub' } } } } }));
    expect((await getPreferences(fileAccount(), 'a@example.org')).liveQuality).toBe('main');
    await savePreferences(fileAccount(), 'a@example.org', { timelineZoom: 6 });
    const all = read(PREFS);
    expect(all.v).toBe(2);
    expect(all.accounts[BETA]).toEqual({ name: 'beta', data: { 'a@example.org': { liveQuality: 'sub' } } });
    const home = Object.values(all.accounts as Record<string, { name: string; data: Record<string, { timelineZoom: number; liveQuality: string }> }>).find((e) => e.name === 'home')!;
    expect(home.data['a@example.org']).toMatchObject({ liveQuality: 'main', timelineZoom: 6 });
  });

  it('two accounts: the same email has independent preferences; defaultCamera must be a camsId of that account', async () => {
    setFleet(twoAccounts({ alphaExtra: [{ id: 'cam9', name: 'Nine', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }] }));
    await savePreferences(ALPHA_REF, 'both@example.org', { liveQuality: 'main' });
    expect((await getPreferences(BETA_REF, 'both@example.org')).liveQuality).toBe('sub');
    expect((await getPreferences(ALPHA_REF, 'both@example.org')).liveQuality).toBe('main');
    expect(validatePreferencesPatch(BETA, { defaultCamera: 'cam9' }).ok).toBe(false); // cam9 exists only in Alpha
    expect(validatePreferencesPatch(ALPHA, { defaultCamera: 'cam9' }).ok).toBe(true);
    expect(read(PREFS).v).toBe(2);
  });

  it('a stored camera of another account is dropped when read (sanitized per account)', async () => {
    setFleet(twoAccounts({ alphaExtra: [{ id: 'cam9', name: 'Nine', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }] }));
    writeFileSync(PREFS, JSON.stringify({ v: 2, accounts: { [BETA]: { name: 'beta', data: { 'both@example.org': { defaultCamera: 'cam9', lastCamera: 'cam1' } } } } }));
    const p = await getPreferences(BETA_REF, 'both@example.org');
    expect(p.defaultCamera).toBeNull();
    expect(p.lastCamera).toBe('cam1');
  });

  it('a corrupt accounts-layout preferences file: reads as defaults, refuses to save over it (today\'s rule kept)', async () => {
    writeFileSync(PREFS, JSON.stringify({ v: 2, accounts: 'nope' }));
    expect(await getPreferences(fileAccount(), 'a@example.org')).toEqual(DEFAULT_PREFERENCES);
    await expect(savePreferences(fileAccount(), 'a@example.org', { timelineZoom: 6 })).rejects.toThrow(/corrupt/);
    expect(read(PREFS)).toEqual({ v: 2, accounts: 'nope' });
  });
});

describe('the proxy switch', () => {
  it('file mode: today\'s layout {cam: false}', async () => {
    await setProxyEnabled(k('cam1'), false);
    expect(read(STATE)).toEqual({ cam1: false });
    loadProxyState();
    expect(proxyEnabled(k('cam1'))).toBe(false);
  });

  it('is per account: switching Alpha cam1 off leaves Beta cam1 on', async () => {
    setFleet(twoAccounts());
    await setProxyEnabled(camKey(ALPHA, 'cam1'), false);
    expect(proxyEnabled(camKey(ALPHA, 'cam1'))).toBe(false);
    expect(proxyEnabled(camKey(BETA, 'cam1'))).toBe(true);
    loadProxyState();
    expect(proxyEnabled(camKey(ALPHA, 'cam1'))).toBe(false);
    expect(proxyEnabled(camKey(BETA, 'cam1'))).toBe(true);
    expect(read(STATE)).toEqual({ v: 2, accounts: { [ALPHA]: { name: 'alpha', data: { cam1: false } } } });
  });

  it('moves into the account layout once, with a .bak; file mode still reads it', async () => {
    writeFileSync(STATE, JSON.stringify({ cam1: false }));
    expect(await moveProxyStateToAccounts(HOME())).toBe(true);
    expect(read(STATE)).toEqual({ v: 2, accounts: { [HOME().id]: { name: 'home', data: { cam1: false } } } });
    expect(read(`${STATE}.pre-accounts.bak`)).toEqual({ cam1: false });
    expect(await moveProxyStateToAccounts(HOME())).toBe(false);
    loadProxyState();
    expect(proxyEnabled(k('cam1'))).toBe(false); // the file account, found by name
  });
});

describe('TLS pins', () => {
  const LEAF = 'cc'.repeat(32), OTHER = 'dd'.repeat(32);
  it('fallback pins are per key; a pin for Alpha cam1 is never used for Beta cam1', async () => {
    setFleet(twoAccounts());
    await setFallbackPin(camKey(ALPHA, 'cam1'), { fingerprint: LEAF, host: '192.0.2.5' });
    expect(fallbackPin(camKey(ALPHA, 'cam1'), '192.0.2.5')).toBe(LEAF);
    expect(fallbackPin(camKey(BETA, 'cam1'), '192.0.2.5')).toBeUndefined();
    loadTlsState();
    expect(fallbackPin(camKey(ALPHA, 'cam1'), '192.0.2.5')).toBe(LEAF);
    expect(fallbackPin(camKey(BETA, 'cam1'), '192.0.2.5')).toBeUndefined();
    expect(read(TLS).pins).toEqual({ [`${ALPHA}/cam1`]: { fingerprint: LEAF, host: '192.0.2.5' } });
    expect(read(TLS).v).toBe(2);
  });

  it('file mode keeps today\'s layout; the move re-keys pins under the account, CAs unchanged', async () => {
    await setFallbackPin(k('cam1'), { fingerprint: LEAF, host: '192.0.2.5' });
    expect(read(TLS)).toEqual({ cas: {}, pins: { cam1: { fingerprint: LEAF, host: '192.0.2.5' } } });
    const home = HOME();
    expect(await moveTlsPinsToAccounts(home)).toBe(true);
    expect(read(TLS)).toEqual({ cas: {}, pins: { [`${home.id}/cam1`]: { fingerprint: LEAF, host: '192.0.2.5' } }, v: 2 });
    expect(statSync(TLS).mode & 0o777).toBe(0o600);
    expect(statSync(`${TLS}.pre-accounts.bak`).mode & 0o777).toBe(0o600);
    expect(await moveTlsPinsToAccounts(home)).toBe(false);
    setFleet([{ ...home, users: null, cameras: keyed(home.id, [{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]) }]);
    loadTlsState();
    expect(fallbackPin(camKey(home.id, 'cam1'), '192.0.2.5')).toBe(LEAF);
    expect(fallbackPin(camKey(home.id, 'cam1'), '192.0.2.6')).toBeUndefined();
    void OTHER;
  });
});

describe('clip cache names', () => {
  it('the clip cache names of Alpha cam1 and Beta cam1 differ and contain no slash', () => {
    const a = cacheName(camKey(ALPHA, 'cam1'), 'x.mp4'), b = cacheName(camKey(BETA, 'cam1'), 'x.mp4');
    expect(a).not.toBe(b);
    expect(a).not.toContain('/');
    expect(b).not.toContain('/');
    expect(a.startsWith(`${ALPHA}.cam1`)).toBe(true);
  });
});
