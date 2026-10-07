// CONFIG_SOURCE (migration P4, M §9.4): file (the default, as before),
// shadow (the file's fleet, compared with cams-admin's) and cams-admin (the
// verified snapshot, from the signed cache when cams-admin is unreachable).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import request from 'supertest';
import { writeCache } from '../server/admin/cache';
import { enroll } from '../server/admin/enroll';
import { writeKeyFile } from '../server/admin/keyfile';
import type { Snapshot } from '../server/admin/snapshot';
import { configStatus, nextDelayMs, pullNow, pullSoon, startConfig, stopConfig } from '../server/configSource';
import { createApp } from '../server/app';
import { listCameras, setCameras } from '../server/cameraRegistry';
import { fileAccount, fleetAccounts, setFileAccountId, DEFAULT_FILE_ACCOUNT_ID } from '../server/fleet';
import { membershipsOf } from '../server/membership';
import { getPreferences } from '../server/preferences';
import { loadProxyState, proxyEnabled } from '../server/proxyState';
import { ALPHA, BETA, cookieFor } from './helpers/fleet';
import { startFakeAdmin, signSnapshot, type FakeAdmin } from './admin/fakeAdmin';
import { twoAccountsSnapshot } from './admin/snapshots';
import { camKey } from '../server/fleet';

let fake: FakeAdmin, dir: string;
const ENV = ['CONFIG_SOURCE', 'CAMS_DATA_DIR', 'CAMERAS_FILE', 'ALLOWED_EMAILS', 'PROXY_STATE_FILE', 'PROXY_TLS_FILE', 'PREFS_FILE', 'CAMS_FILE_ACCOUNT'] as const;
const saved: Record<string, string | undefined> = {};
const SNAP = (o: Parameters<typeof twoAccountsSnapshot>[0] = {}) => signSnapshot(twoAccountsSnapshot(o)) as unknown as Snapshot;
const FAST = { pullIntervalMs: 60_000, debounceMs: 30 };

beforeEach(async () => {
  for (const n of ENV) saved[n] = process.env[n];
  fake = await startFakeAdmin();
  dir = mkdtempSync(join(tmpdir(), 'cams-config-'));
  process.env.CAMS_DATA_DIR = dir;
  process.env.PREFS_FILE = join(dir, 'prefs.json');
  process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
  process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
  delete process.env.CAMERAS_FILE;
});
afterEach(async () => {
  stopConfig();
  await fake.stop();
  for (const n of ENV) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  setFileAccountId(DEFAULT_FILE_ACCOUNT_ID);
  setCameras([]);
  loadProxyState();
});

async function enrolled() {
  writeKeyFile(await enroll(fake.url, fake.code, 'test'), dir);
}
const cams = (accountId: string) => listCameras(accountId).map((c) => c.id);

describe('cams-admin mode', () => {
  it('starts from the cache with cams-admin down; sign-in, roles and cameras come from it', async () => {
    await enrolled();
    writeCache(SNAP(), dir);
    fake.down();
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    expect(cams(ALPHA)).toEqual(['cam1']);
    expect(cams(BETA)).toEqual(['cam1']);
    expect(membershipsOf('both@example.org').map((m) => m.role)).toEqual(['admin', 'viewer']);
    expect(configStatus()).toMatchObject({ mode: 'cams-admin', appliedRevision: 'r:00000000000000a1' });
    const me = await request(createApp()).get('/api/me').set('Cookie', cookieFor('both@example.org', BETA));
    expect(me.body).toMatchObject({ role: 'viewer', account: { id: BETA } });
  });

  it('a tampered cache is ignored and logged config_cache_untrusted; start continues with the next pull', async () => {
    await enrolled();
    writeCache({ ...SNAP(), generatedAt: 5 } as Snapshot, dir);
    fake.setSnapshot(twoAccountsSnapshot({ revision: 'r:00000000000000b2' }));
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    await expect.poll(() => configStatus().appliedRevision).toBe('r:00000000000000b2');
    expect(cams(ALPHA)).toEqual(['cam1']);
  });

  it('neither cache nor cams-admin: empty fleet, the sign-in page says "No cameras are configured yet"', async () => {
    await enrolled();
    fake.down();
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    expect(fleetAccounts()).toEqual([]);
    const saveWeb = process.env.WEB_DIST;
    process.env.WEB_DIST = resolve(__dirname, 'fixtures/web');
    try {
      const page = await request(createApp()).get('/');
      expect(page.text).toContain('<meta name="cams-config" content="none" />');
    } finally {
      if (saveWeb === undefined) delete process.env.WEB_DIST;
      else process.env.WEB_DIST = saveWeb;
    }
  });

  it('pull: 304 changes nothing; 200 applies, writes the cache, reports; a failed pull backs off to 5 min and keeps the configuration', async () => {
    await enrolled();
    fake.setSnapshot(twoAccountsSnapshot());
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    await expect.poll(() => configStatus().appliedRevision).toBe('r:00000000000000a1');
    expect(JSON.parse(readFileSync(join(dir, 'admin/config-cache.json'), 'utf8')).sig).toBeTruthy();
    await expect.poll(() => fake.reports.length).toBeGreaterThan(0);
    
    const gets = fake.configGets;
    await pullNow();
    expect(fake.configGets).toBe(gets + 1);
    expect(fake.requests.at(-1)!.status).toBe(304);
    fake.setSnapshot(twoAccountsSnapshot({ revision: 'r:00000000000000c3', alphaCameras: [] }));
    await pullNow();
    expect(cams(ALPHA)).toEqual([]);
    fake.down();
    for (let i = 0; i < 6; i++) await pullNow();
    expect(cams(BETA)).toEqual(['cam1']);
    expect(nextDelayMs()).toBeGreaterThanOrEqual(270_000);
    expect(nextDelayMs()).toBeLessThanOrEqual(330_000);
    expect(configStatus().appliedRevision).toBe('r:00000000000000c3');
  });

  it('a snapshot with one bad account keeps that account\'s last good part and reports snapshot_invalid', async () => {
    await enrolled();
    fake.setSnapshot(twoAccountsSnapshot());
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    await expect.poll(() => configStatus().appliedRevision).toBe('r:00000000000000a1');
    fake.setSnapshot(twoAccountsSnapshot({ revision: 'r:00000000000000d4', alphaCameras: [{ id: 'cam_X', camsId: 'cam1', name: 'x', proxyId: null, proxyCameraId: null, host: 'h', protocol: 'ftp', tlsServername: null, cameraUser: 'c', webUiUrl: null, webUiNote: null }] }));
    
    await pullNow();
    expect(cams(ALPHA)).toEqual(['cam1']);
    expect(listCameras(ALPHA)[0].name).toBe('Alpha cam');
    expect(configStatus().problems).toContainEqual(expect.objectContaining({ code: 'snapshot_invalid', accountId: ALPHA }));
  });

  it('an older signed snapshot (a replay) is refused: the newer configuration stays', async () => {
    await enrolled();
    fake.setSnapshot(twoAccountsSnapshot({ revision: 'r:00000000000000a7' }));
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    await expect.poll(() => configStatus().appliedRevision).toBe('r:00000000000000a7');
    fake.setSnapshot({ ...twoAccountsSnapshot({ revision: 'r:00000000000000a6', alphaCameras: [] }), generatedAt: 1791273600000 - 1000 });
    await pullNow();
    expect(configStatus().appliedRevision).toBe('r:00000000000000a7');
    expect(cams(ALPHA)).toEqual(['cam1']);
    expect(configStatus().problems).toContainEqual(expect.objectContaining({ code: 'snapshot_older' }));
  });

  it('a revoked instance (or an unknown key): the cached configuration stays, admins see the state on /api/me', async () => {
    await enrolled();
    writeCache(SNAP(), dir);
    fake.setSnapshot(twoAccountsSnapshot());
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    await expect.poll(() => configStatus().lastPullOkAt).not.toBeNull();
    fake.revoked = true;
    await pullNow();
    expect(cams(ALPHA)).toEqual(['cam1']);
    expect(configStatus().adminRefusal).toBe('revoked');
    const admin = await request(createApp()).get('/api/me').set('Cookie', cookieFor('both@example.org', ALPHA));
    expect(admin.body.configProblem).toBe('revoked');
    const viewer = await request(createApp()).get('/api/me').set('Cookie', cookieFor('both@example.org', BETA));
    expect(viewer.body.configProblem).toBeNull();
    fake.revoked = false;
    await pullNow();
    expect(configStatus().adminRefusal).toBeNull();
    fake.keyId = 'key_99999999999999999999'; // re-enrolled elsewhere: our key is unknown now
    await pullNow();
    expect(configStatus().adminRefusal).toBe('unknown_key');
  });

  it('a pull at once after a sign-in (debounced)', async () => {
    await enrolled();
    fake.setSnapshot(twoAccountsSnapshot());
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    await expect.poll(() => configStatus().appliedRevision).toBe('r:00000000000000a1');
    await new Promise((r) => setTimeout(r, 150)); // the start report's own "changed" pull settles first
    const gets = fake.configGets;
    pullSoon('login');
    pullSoon('login');
    await expect.poll(() => fake.configGets).toBe(gets + 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.configGets).toBe(gets + 1);
  });

  it('staleSince: null for 24 h after the last good pull, then that time (admins see it on /api/me)', async () => {
    await enrolled();
    writeCache(SNAP(), dir);
    const old = Date.now() - 30 * 3_600_000;
    utimesSync(join(dir, 'admin/config-cache.json'), old / 1000, old / 1000);
    fake.down();
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    expect(configStatus().staleSince).toBeCloseTo(old, -3);
    const admin = await request(createApp()).get('/api/me').set('Cookie', cookieFor('both@example.org', ALPHA));
    expect(admin.body.staleSince).toBeCloseTo(old, -3);
    const viewer = await request(createApp()).get('/api/me').set('Cookie', cookieFor('both@example.org', BETA));
    expect(viewer.body.staleSince).toBeNull();
    fake.up();
    fake.setSnapshot(twoAccountsSnapshot());
    
    await pullNow();
    expect(configStatus().staleSince).toBeNull();
  });

  it('the first cams-admin start moves preferences, proxy switch and pins into the account named home; file mode afterwards still reads them', async () => {
    await enrolled();
    writeFileSync(process.env.PREFS_FILE!, JSON.stringify({ 'both@example.org': { liveQuality: 'main' } }));
    writeFileSync(process.env.PROXY_STATE_FILE!, JSON.stringify({ cam1: false }));
    writeCache(signSnapshot(twoAccountsSnapshot({ homeName: 'home' })) as unknown as Snapshot, dir);
    fake.down();
    process.env.CONFIG_SOURCE = 'cams-admin';
    await startConfig(FAST);
    expect(JSON.parse(readFileSync(process.env.PREFS_FILE!, 'utf8')).accounts[ALPHA].name).toBe('home');
    expect(existsSync(`${process.env.PREFS_FILE}.pre-accounts.bak`)).toBe(true);
    expect(proxyEnabled(camKey(ALPHA, 'cam1'))).toBe(false);
    expect(proxyEnabled(camKey(BETA, 'cam1'))).toBe(true);
    stopConfig();
    // rollback: file mode, with the cache telling it the home account's id
    process.env.CONFIG_SOURCE = 'file';
    process.env.CAMERAS_FILE = join(dir, 'cameras.json');
    writeFileSync(process.env.CAMERAS_FILE, JSON.stringify([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]));
    await startConfig(FAST);
    expect(fileAccount().id).toBe(ALPHA);
    expect((await getPreferences(fileAccount(), 'both@example.org')).liveQuality).toBe('main');
    expect(proxyEnabled(camKey(ALPHA, 'cam1'))).toBe(false);
  });

  it('ALLOWED_EMAILS in cams-admin mode is ignored (a start warning)', async () => {
    await enrolled();
    writeCache(SNAP(), dir);
    fake.down();
    process.env.CONFIG_SOURCE = 'cams-admin';
    process.env.ALLOWED_EMAILS = 'stranger@example.org';
    await startConfig(FAST);
    expect(membershipsOf('stranger@example.org')).toEqual([]);
    expect(configStatus().problems).toContainEqual(expect.objectContaining({ code: 'allowed_emails_ignored' }));
  });
});

describe('tokens in cams-admin mode (R4-12)', () => {
  it('registers its own tokens; uses the legacy file token until the snapshot lists them active, then switches', async () => {
    await enrolled();
    process.env.CONFIG_SOURCE = 'cams-admin';
    process.env.CAMERAS_FILE = join(dir, 'cameras.json');
    writeFileSync(process.env.CAMERAS_FILE, JSON.stringify([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'cams', password: 'p', proxy: { url: 'http://127.0.0.1:1/alpha', token: 'L'.repeat(40) } }]));
    fake.setSnapshot(twoAccountsSnapshot({ homeName: 'home' }));
    await startConfig(FAST);
    await expect.poll(() => fake.registered.length).toBe(4);
    const { getCamera } = await import('../server/cameraRegistry.js');
    expect(getCamera(camKey(ALPHA, 'cam1'))?.proxy?.token).toBe('L'.repeat(40)); // legacy, the file account's
    expect(getCamera(camKey(BETA, 'cam1'))?.proxy).toBeUndefined(); // no token yet
    for (const t of fake.tokens) t.state = 'active';
    const rows = (proxyId: string) => fake.tokens.filter((t) => t.proxyId === proxyId).map((t) => ({ id: t.tokenId, kind: t.kind, state: t.state, retireAt: null }));
    fake.setSnapshot(twoAccountsSnapshot({ homeName: 'home', revision: 'r:00000000000000f1', tokens: { a: rows('prx_AAAAAAAAAAAAAAAAAAAA'), b: rows('prx_BBBBBBBBBBBBBBBBBBBB') } }));
    await pullNow();
    const local = JSON.parse(readFileSync(join(dir, 'admin/tokens.json'), 'utf8')).tokens as { proxyId: string; kind: string; token: string }[];
    expect(getCamera(camKey(ALPHA, 'cam1'))?.proxy?.token).toBe(local.find((t) => t.proxyId === 'prx_AAAAAAAAAAAAAAAAAAAA' && t.kind === 'client')!.token);
    expect(getCamera(camKey(BETA, 'cam1'))?.proxy?.adminToken).toBe(local.find((t) => t.proxyId === 'prx_BBBBBBBBBBBBBBBBBBBB' && t.kind === 'admin')!.token);
    await expect.poll(() => fake.reports.at(-1)?.tokens).toEqual({ managed: 4, pending: 0, legacy: 0 });
  });
});

describe('file and shadow mode', () => {
  it('file mode: today\'s file, no key file needed, no pulls', async () => {
    process.env.CAMERAS_FILE = join(dir, 'cameras.json');
    writeFileSync(process.env.CAMERAS_FILE, JSON.stringify([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]));
    await startConfig(FAST);
    expect(cams(fileAccount().id)).toEqual(['cam1']);
    expect(fake.configGets).toBe(0);
    expect(configStatus().mode).toBe('file');
  });

  it('shadow mode serves the file\'s fleet even when the snapshot differs', async () => {
    await enrolled();
    process.env.CONFIG_SOURCE = 'shadow';
    process.env.CAMERAS_FILE = join(dir, 'cameras.json');
    writeFileSync(process.env.CAMERAS_FILE, JSON.stringify([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]));
    fake.setSnapshot(twoAccountsSnapshot({ homeName: 'home' }));
    await startConfig(FAST);
    await expect.poll(() => configStatus().appliedRevision).toBe('r:00000000000000a1');
    expect(fleetAccounts().map((a) => a.name)).toEqual(['home']);
    expect(cams(fileAccount().id)).toEqual(['den']);
    expect(membershipsOf('both@example.org')).toEqual([]); // ALLOWED_EMAILS still decides
  });

  it('shadow mode reports 0 differences when the file equals cams-admin\'s file account, else names them', async () => {
    await enrolled();
    process.env.CONFIG_SOURCE = 'shadow';
    process.env.CAMERAS_FILE = join(dir, 'cameras.json');
    const cam = { id: 'cam1', name: 'Alpha cam', host: '127.0.0.1:9', protocol: 'http', user: 'cams', password: 'p', proxy: { url: 'http://127.0.0.1:1/alpha', token: 'L'.repeat(40) } };
    writeFileSync(process.env.CAMERAS_FILE, JSON.stringify([cam]));
    fake.setSnapshot(twoAccountsSnapshot({ homeName: 'home' }));
    await startConfig(FAST);
    await expect.poll(() => fake.reports.at(-1)?.shadow).toEqual({ accountId: ALPHA, differences: 0, items: [] });
    expect(fake.reports.at(-1)?.mode).toBe('shadow');
    stopConfig();
    writeFileSync(process.env.CAMERAS_FILE, JSON.stringify([{ ...cam, host: '127.0.0.1:10' }]));
    await startConfig(FAST);
    await expect.poll(() => fake.reports.at(-1)?.shadow).toEqual({ accountId: ALPHA, differences: 1, items: ['cam1: host'] });
    expect(JSON.stringify(fake.reports)).not.toContain('127.0.0.1:10');
  });

  it('CONFIG_SOURCE=bogus fails start naming CONFIG_SOURCE; shadow without a key file fails naming admin-enroll', async () => {
    process.env.CONFIG_SOURCE = 'bogus';
    await expect(startConfig(FAST)).rejects.toThrow(/CONFIG_SOURCE/);
    process.env.CONFIG_SOURCE = 'shadow';
    await expect(startConfig(FAST)).rejects.toThrow(/admin-enroll/);
    process.env.CONFIG_SOURCE = 'cams-admin';
    await expect(startConfig(FAST)).rejects.toThrow(/admin-enroll/);
  });
});
