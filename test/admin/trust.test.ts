// Held trust changes (migration P4, M6, M §9.7, R4-7, R4-11; security review
// C1, I1, I2): connection data — proxy URL, pins, TLS names, camera host,
// protocol — is used only once an account admin confirmed it. A camera with
// no confirmed values (new, re-created, or under another account id) is held
// too, and nothing confirms by itself except the first-start seed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TrustStore, trustValuesOf, type ProxyTrust, type TrustValues } from '../../server/admin/trust';
import type { SnapCamera, SnapProxy } from '../../server/admin/snapshot';
import { logger } from '../../server/logger';
import { ALPHA, ALPHA_REF, BETA } from '../helpers/fleet';

const dirOf = () => mkdtempSync(join(tmpdir(), 'cams-trust-'));
const V = (o: Partial<TrustValues> = {}): TrustValues => ({ proxyUrl: 'http://127.0.0.1:8480', caFingerprints: [], proxyTlsServername: null, host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.example.net', ...o });
const REV = 'r:00000000000000a1';
// What an admin's Confirm click sends: the digest of the offer the banner showed.
async function confirmAs(t: TrustStore, camsId: string, rev = REV) {
  return t.confirm(ALPHA, [{ camsId, digest: t.offerDigest(ALPHA, camsId, rev)! }], rev, 'admin@example.org');
}

describe('TrustStore', () => {
  it('seeded from CAMERAS_FILE at the first cams-admin start: an equal snapshot holds nothing, and the file account id is recorded', () => {
    const t = TrustStore.load(dirOf());
    expect(t.exists()).toBe(false);
    t.seedFromFile(ALPHA_REF, [{ id: 'cam1', name: 'Den', host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.example.net', user: 'u', password: 'p', proxy: { url: 'http://127.0.0.1:8480/', token: 't'.repeat(40) } }]);
    expect(t.exists()).toBe(true);
    expect(t.fileAccountId()).toBe(ALPHA);
    expect(t.decide(ALPHA, 'cam1', V())).toEqual({ use: V(), confirmed: true, held: null });
  });

  it('the file account id is recorded once even when trust.json was written before that account appeared (N2); never moved afterwards', async () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    t.decide(ALPHA, 'cam9', V());
    await confirmAs(t, 'cam9'); // trust.json exists now, no file account yet
    expect(t.fileAccountId()).toBeNull();
    t.recordFileAccount('acc_HOMEHOMEHOMEHOMEHOME');
    expect(TrustStore.load(dir).fileAccountId()).toBe('acc_HOMEHOMEHOMEHOMEHOME');
    t.recordFileAccount('acc_OTHEROTHEROTHEROTHER');
    expect(TrustStore.load(dir).fileAccountId()).toBe('acc_HOMEHOMEHOMEHOMEHOME');
  });

  it('a new camera is held (never confirmed by itself, credentials or not): its offer shows, it is not confirmed', () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    const d = t.decide(ALPHA, 'cam9', V());
    expect(d.confirmed).toBe(false);
    expect(d.held).toMatchObject({ camsId: 'cam9', isNew: true, confirmed: null, offered: V(), keptOld: false });
    expect(TrustStore.load(dir).decide(ALPHA, 'cam9', V()).confirmed).toBe(false); // nothing was saved
  });

  it('Confirm carries the digest of the offer shown: a changed offer, another revision or a second click confirm nothing', async () => {
    const t = TrustStore.load(dirOf());
    t.decide(ALPHA, 'cam9', V());
    const shown = t.offerDigest(ALPHA, 'cam9', REV)!;
    t.decide(ALPHA, 'cam9', V({ host: '203.0.113.66' })); // the next pull swapped the offer
    expect(await t.confirm(ALPHA, [{ camsId: 'cam9', digest: shown }], REV, 'a@example.org')).toEqual({ done: [], changed: ['cam9'] });
    expect(t.decide(ALPHA, 'cam9', V({ host: '203.0.113.66' })).confirmed).toBe(false);
    const now = t.offerDigest(ALPHA, 'cam9', REV)!;
    expect(await t.confirm(ALPHA, [{ camsId: 'cam9', digest: now }], 'r:00000000000000b2', 'a@example.org')).toEqual({ done: [], changed: ['cam9'] });
    expect(await t.confirm(ALPHA, [{ camsId: 'cam9', digest: now }], REV, 'a@example.org')).toEqual({ done: ['cam9'], changed: [] });
    expect(t.decide(ALPHA, 'cam9', V({ host: '203.0.113.66' }))).toEqual({ use: V({ host: '203.0.113.66' }), confirmed: true, held: null });
    expect(await t.confirm(ALPHA, [{ camsId: 'cam9', digest: now }], REV, 'a@example.org')).toEqual({ done: [], changed: ['cam9'] }); // one-shot
  });

  it('a changed host is held: the camera keeps the old host; Confirm moves it and it persists', async () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    t.decide(ALPHA, 'cam1', V());
    await confirmAs(t, 'cam1');
    const d = t.decide(ALPHA, 'cam1', V({ host: '192.0.2.99' }));
    expect(d.use).toEqual(V());
    expect(d.confirmed).toBe(true);
    expect(d.held).toMatchObject({ accountId: ALPHA, camsId: 'cam1', fields: ['host'], confirmed: V(), offered: V({ host: '192.0.2.99' }), keptOld: false });
    expect(t.held(ALPHA)).toHaveLength(1);
    await confirmAs(t, 'cam1');
    expect(t.decide(ALPHA, 'cam1', V({ host: '192.0.2.99' }))).toEqual({ use: V({ host: '192.0.2.99' }), confirmed: true, held: null });
    expect(TrustStore.load(dir).decide(ALPHA, 'cam1', V({ host: '192.0.2.99' })).held).toBeNull();
    const file = JSON.parse(readFileSync(join(dir, 'admin/trust.json'), 'utf8'));
    expect(file.log.at(-1)).toMatchObject({ email: 'admin@example.org', accountId: ALPHA, camsIds: ['cam1'], action: 'confirm' });
  });

  it('a changed proxy URL holds every camera of that proxy, with the old URL and the old pins (never a mix)', async () => {
    const t = TrustStore.load(dirOf());
    const pin = 'a'.repeat(64);
    for (const c of ['cam1', 'cam2']) {
      t.decide(ALPHA, c, V({ caFingerprints: [pin] }));
      await confirmAs(t, c);
    }
    for (const c of ['cam1', 'cam2']) {
      const d = t.decide(ALPHA, c, V({ proxyUrl: 'https://evil.example:8443', caFingerprints: ['b'.repeat(64)] }));
      expect(d.use).toEqual(V({ caFingerprints: [pin] }));
      expect(d.held?.fields).toEqual(['proxyUrl', 'caFingerprints']);
    }
  });

  it('https → http is held (R4-7); a camera deleted and re-created with the same camsId is a change, never new', async () => {
    const t = TrustStore.load(dirOf());
    t.decide(ALPHA, 'cam1', V());
    await confirmAs(t, 'cam1');
    expect(t.decide(ALPHA, 'cam1', V({ protocol: 'http' })).held?.fields).toEqual(['protocol']);
    t.forgetOffers();
    expect(t.decide(ALPHA, 'cam1', V({ host: '198.51.100.7' })).held).toMatchObject({ fields: ['host'], isNew: false });
  });

  it('Keep old: the banner hides, the report lists keptOld, a new different offer shows again', async () => {
    const t = TrustStore.load(dirOf());
    t.decide(ALPHA, 'cam1', V());
    await confirmAs(t, 'cam1');
    t.decide(ALPHA, 'cam1', V({ host: 'b' }));
    await t.keepOld(ALPHA, [{ camsId: 'cam1', digest: t.offerDigest(ALPHA, 'cam1', REV)! }], REV, 'admin@example.org');
    const d = t.decide(ALPHA, 'cam1', V({ host: 'b' }));
    expect(d.use).toEqual(V());
    expect(d.held).toMatchObject({ keptOld: true });
    expect(t.held(ALPHA).filter((h) => !h.keptOld)).toEqual([]);
    expect(t.decide(ALPHA, 'cam1', V({ host: 'c' })).held).toMatchObject({ keptOld: false, fields: ['host'] });
  });

  it('trust.json is 600; a corrupt one stops a cams-admin-mode start with a message naming the file', () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    t.seedFromFile(ALPHA_REF, []);
    expect(statSync(join(dir, 'admin/trust.json')).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, 'admin/trust.json'), '{nope', { mode: 0o600 });
    expect(() => TrustStore.load(dir)).toThrow(/trust\.json/);
    writeFileSync(join(dir, 'admin/trust.json'), JSON.stringify({ v: 1, confirmed: {}, keptOld: {}, log: [] }));
    chmodSync(join(dir, 'admin/trust.json'), 0o644);
    expect(() => TrustStore.load(dir)).toThrow(/trust\.json/);
  });

  it('trustValuesOf normalises pins and sorts them', () => {
    const v = trustValuesOf({ host: 'h', protocol: 'https', proxy: { url: 'https://p:8443/', caFingerprint: [`${'b'.repeat(64)}`, `SHA256:${'A'.repeat(64)}`], tlsServername: 'p.example' } });
    expect(v).toEqual({ proxyUrl: 'https://p:8443', caFingerprints: ['a'.repeat(64), 'b'.repeat(64)], proxyTlsServername: 'p.example', host: 'h', protocol: 'https', tlsServername: null });
  });
});

// Trusted proxies (camera move, S §9.2, M1, M2): per account, the three proxy
// values an admin confirmed once (or the seed took from confirmed cameras).
describe('TrustStore: trusted proxies', () => {
  const PRX = 'prx_PPPPPPPPPPPPPPPPPPPP', PRX2 = 'prx_QQQQQQQQQQQQQQQQQQQQ';
  const PIN = 'a'.repeat(64), PIN2 = 'b'.repeat(64);
  const sp = (o: Partial<SnapProxy> = {}): SnapProxy => ({ id: PRX, name: 'home', displayName: 'Home', url: 'https://192.0.2.10:8443/', adminUiUrl: null, tlsServername: 'proxy.home.internal', caFingerprints: [`SHA256:${'A'.repeat(64)}`], site: 'home', tokens: [], ...o });
  const sc = (camsId: string, o: Partial<SnapCamera> = {}): SnapCamera => ({ id: `cam_${camsId.toUpperCase().padEnd(20, 'X')}`, camsId, name: camsId, proxyId: PRX, proxyCameraId: camsId, host: '192.0.2.5', protocol: 'https', tlsServername: `${camsId}.home.internal`, cameraUser: 'u', webUiUrl: null, webUiNote: null, moveId: null, move: null, ...o });
  const PT = (o: Partial<ProxyTrust> = {}): ProxyTrust => ({ proxyUrl: 'https://192.0.2.10:8443', caFingerprints: [PIN], proxyTlsServername: 'proxy.home.internal', ...o });
  const camV = (camsId: string, o: Partial<TrustValues> = {}) => V({ ...PT(), host: '192.0.2.5', protocol: 'https', tlsServername: `${camsId}.home.internal`, ...o });
  const trustFile = (dir: string) => JSON.parse(readFileSync(join(dir, 'admin/trust.json'), 'utf8'));
  // A store with cam1 confirmed on PRX (as the current release writes it: no `proxies`).
  const oldFile = (dir: string, confirmed: Record<string, TrustValues> = { [`${ALPHA}/cam1`]: camV('cam1') }) => {
    mkdirSync(join(dir, 'admin'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'admin/trust.json'), JSON.stringify({ v: 1, confirmed, keptOld: {}, fileAccountId: ALPHA, log: [] }), { mode: 0o600 });
  };
  const confirmProxy = (t: TrustStore, accountId: string, proxyId: string) => {
    const h = t.heldProxies(accountId).find((x) => x.proxyId === proxyId)!;
    return t.confirmProxies('admin@example.org', accountId, [{ proxyId, digest: h.digest }]);
  };

  it('old trust.json without proxies loads (the current release, M4)', () => {
    const dir = dirOf();
    oldFile(dir);
    const t = TrustStore.load(dir);
    expect(t.decide(ALPHA, 'cam1', camV('cam1'))).toMatchObject({ confirmed: true, held: null });
    expect(t.isTrusted(ALPHA, PRX, PT())).toBe(false);
  });

  it('a corrupt proxies map stops the start', () => {
    const dir = dirOf();
    mkdirSync(join(dir, 'admin'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'admin/trust.json'), JSON.stringify({ v: 1, confirmed: {}, keptOld: {}, proxies: { [`${ALPHA}/${PRX}`]: { proxyUrl: 'x' } }, log: [] }), { mode: 0o600 });
    expect(() => TrustStore.load(dir)).toThrow(/trust\.json/);
    writeFileSync(join(dir, 'admin/trust.json'), JSON.stringify({ v: 1, confirmed: {}, keptOld: {}, proxies: [], log: [] }), { mode: 0o600 });
    expect(() => TrustStore.load(dir)).toThrow(/trust\.json/);
  });

  it('seeds once: a second start does not seed; the log has one seed-proxies with ids only; the file stays 600', () => {
    const dir = dirOf();
    oldFile(dir);
    const accounts = [{ id: ALPHA, proxies: [sp()], cameras: [sc('cam1')] }];
    TrustStore.load(dir).seedProxiesOnce(accounts);
    const t2 = TrustStore.load(dir);
    expect(t2.isTrusted(ALPHA, PRX, PT())).toBe(true);
    // A second start: the proxy's trust was revoked by hand meanwhile; no seed brings it back.
    const f = trustFile(dir);
    f.proxies = {};
    writeFileSync(join(dir, 'admin/trust.json'), JSON.stringify(f), { mode: 0o600 });
    TrustStore.load(dir).seedProxiesOnce(accounts);
    expect(TrustStore.load(dir).isTrusted(ALPHA, PRX, PT())).toBe(false);
    const log = trustFile(dir).log.filter((e: { action: string }) => e.action === 'seed-proxies');
    expect(log).toEqual([{ at: expect.any(Number), email: '', accountId: '', camsIds: [], proxyIds: [`${ALPHA}/${PRX}`], action: 'seed-proxies' }]);
    expect(JSON.stringify(trustFile(dir).log)).not.toContain('192.0.2.10');
    expect(statSync(join(dir, 'admin/trust.json')).mode & 0o777).toBe(0o600);
  });

  it('seeding with nothing to trust still marks the store seeded', () => {
    const dir = dirOf();
    oldFile(dir, {});
    TrustStore.load(dir).seedProxiesOnce([{ id: ALPHA, proxies: [sp()], cameras: [sc('cam1')] }]);
    expect(trustFile(dir).proxies).toEqual({});
  });

  it('no seed before trust.json exists (the camera seed comes first)', () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    t.seedProxiesOnce([{ id: ALPHA, proxies: [sp()], cameras: [sc('cam1')] }]);
    expect(t.exists()).toBe(false);
  });

  it('seeding trusts only proxies whose offer equals a confirmed camera\'s values', () => {
    const dir = dirOf();
    const other = sp({ id: PRX2, url: 'https://192.0.2.20:8443', caFingerprints: [PIN2] });
    const third = sp({ id: 'prx_RRRRRRRRRRRRRRRRRRRR', url: 'https://192.0.2.30:8443' });
    oldFile(dir, {
      [`${ALPHA}/cam1`]: camV('cam1'), // equal to PRX's offer
      [`${ALPHA}/cam2`]: camV('cam2', { caFingerprints: [PIN2] }), // PRX2's offer has PIN2, but its URL differs from cam2's confirmed one
      // cam3 on the third proxy: never confirmed
    });
    const t = TrustStore.load(dir);
    t.seedProxiesOnce([{ id: ALPHA, proxies: [sp(), other, third], cameras: [sc('cam1'), sc('cam2', { proxyId: PRX2 }), sc('cam3', { proxyId: third.id })] }]);
    expect(t.isTrusted(ALPHA, PRX, PT())).toBe(true);
    expect(t.isTrusted(ALPHA, PRX2, PT({ proxyUrl: 'https://192.0.2.20:8443', caFingerprints: [PIN2] }))).toBe(false);
    expect(t.isTrusted(ALPHA, third.id, PT({ proxyUrl: 'https://192.0.2.30:8443' }))).toBe(false);
    expect(Object.keys(trustFile(dir).proxies)).toEqual([`${ALPHA}/${PRX}`]);
  });

  it('a proxy with a changed pin is held and not trusted; Confirm trusts it (digest-bound)', () => {
    const dir = dirOf();
    oldFile(dir);
    const t = TrustStore.load(dir);
    t.seedProxiesOnce([{ id: ALPHA, proxies: [sp()], cameras: [sc('cam1')] }]);
    t.proxyOffer(ALPHA, sp(), REV);
    expect(t.heldProxies(ALPHA)).toEqual([]);
    const changed = sp({ caFingerprints: [PIN2] });
    t.proxyOffer(ALPHA, changed, REV);
    expect(t.isTrusted(ALPHA, PRX, PT({ caFingerprints: [PIN2] }))).toBe(false);
    expect(t.isTrusted(ALPHA, PRX, PT())).toBe(true); // the old values stay trusted
    const [h, ...rest] = t.heldProxies(ALPHA);
    expect(rest).toEqual([]);
    expect(h).toEqual({ accountId: ALPHA, proxyId: PRX, name: 'Home', fields: ['caFingerprints'], trusted: PT(), offered: PT({ caFingerprints: [PIN2] }), digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(t.confirmProxies('admin@example.org', ALPHA, [{ proxyId: PRX, digest: h.digest }])).toEqual({ confirmed: [PRX], changed: [] });
    expect(t.isTrusted(ALPHA, PRX, PT({ caFingerprints: [PIN2] }))).toBe(true);
    expect(t.heldProxies(ALPHA)).toEqual([]);
    expect(TrustStore.load(dir).isTrusted(ALPHA, PRX, PT({ caFingerprints: [PIN2] }))).toBe(true);
    expect(trustFile(dir).log.at(-1)).toEqual({ at: expect.any(Number), email: 'admin@example.org', accountId: ALPHA, camsIds: [], proxyIds: [PRX], action: 'confirm-proxy' });
    // one-shot
    expect(t.confirmProxies('admin@example.org', ALPHA, [{ proxyId: PRX, digest: h.digest }])).toEqual({ confirmed: [], changed: [PRX] });
  });

  it('a new proxy is held with trusted null', () => {
    const t = TrustStore.load(dirOf());
    t.proxyOffer(ALPHA, sp(), REV);
    expect(t.heldProxies()).toEqual([expect.objectContaining({ proxyId: PRX, trusted: null, fields: ['proxyUrl', 'caFingerprints', 'proxyTlsServername'] })]);
  });

  it('confirmProxies with a stale digest changes nothing (all or nothing)', () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    t.proxyOffer(ALPHA, sp(), REV);
    t.proxyOffer(ALPHA, sp({ id: PRX2, url: 'https://192.0.2.20:8443' }), REV);
    const [a, b] = t.heldProxies(ALPHA);
    t.proxyOffer(ALPHA, sp({ caFingerprints: [PIN2] }), REV); // the next pull swapped PRX's offer
    expect(t.confirmProxies('admin@example.org', ALPHA, [{ proxyId: a.proxyId, digest: a.digest }, { proxyId: b.proxyId, digest: b.digest }])).toEqual({ confirmed: [], changed: [PRX] });
    expect(t.isTrusted(ALPHA, PRX2, PT({ proxyUrl: 'https://192.0.2.20:8443' }))).toBe(false);
    expect(t.isTrusted(ALPHA, PRX, PT({ caFingerprints: [PIN2] }))).toBe(false);
    expect(t.exists()).toBe(false); // nothing saved
    // another revision: the digest no longer matches
    const fresh = t.heldProxies(ALPHA).find((h) => h.proxyId === PRX)!;
    t.proxyOffer(ALPHA, sp({ caFingerprints: [PIN2] }), 'r:00000000000000b2');
    expect(t.confirmProxies('admin@example.org', ALPHA, [{ proxyId: PRX, digest: fresh.digest }])).toEqual({ confirmed: [], changed: [PRX] });
    // an unknown proxy id
    expect(t.confirmProxies('admin@example.org', ALPHA, [{ proxyId: 'prx_ZZZZZZZZZZZZZZZZZZZZ', digest: fresh.digest }])).toEqual({ confirmed: [], changed: ['prx_ZZZZZZZZZZZZZZZZZZZZ'] });
  });

  it('proxy trust is per account: the same proxy id confirmed in one account is not trusted in the other (Review Focus 4)', () => {
    const t = TrustStore.load(dirOf());
    t.proxyOffer(ALPHA, sp(), REV);
    t.proxyOffer(BETA, sp(), REV);
    expect(t.heldProxies()).toHaveLength(2);
    confirmProxy(t, ALPHA, PRX);
    expect(t.isTrusted(ALPHA, PRX, PT())).toBe(true);
    expect(t.isTrusted(BETA, PRX, PT())).toBe(false);
    expect(t.heldProxies(ALPHA)).toEqual([]);
    expect(t.heldProxies(BETA)).toEqual([expect.objectContaining({ accountId: BETA, proxyId: PRX, trusted: null })]);
    // ALPHA's digest does not confirm BETA's item
    t.proxyOffer(ALPHA, sp({ caFingerprints: [PIN2] }), REV);
    const alphaDigest = t.heldProxies(ALPHA)[0].digest;
    expect(t.confirmProxies('admin@example.org', BETA, [{ proxyId: PRX, digest: alphaDigest }])).toEqual({ confirmed: [], changed: [PRX] });
    expect(t.isTrusted(BETA, PRX, PT({ caFingerprints: [PIN2] }))).toBe(false);
  });

  it('proxies survive a save of a camera confirm', async () => {
    const dir = dirOf();
    oldFile(dir);
    const t = TrustStore.load(dir);
    t.seedProxiesOnce([{ id: ALPHA, proxies: [sp()], cameras: [sc('cam1')] }]);
    t.decide(ALPHA, 'cam9', V());
    await confirmAs(t, 'cam9');
    const t2 = TrustStore.load(dir);
    expect(t2.isTrusted(ALPHA, PRX, PT())).toBe(true);
    expect(trustFile(dir).proxies).toEqual({ [`${ALPHA}/${PRX}`]: PT() });
  });

  it('forgetOffers forgets the proxy offers too (their trust stays)', () => {
    const t = TrustStore.load(dirOf());
    t.proxyOffer(ALPHA, sp(), REV);
    t.forgetOffers();
    expect(t.heldProxies()).toEqual([]);
  });
});

// The move rule (camera move, S §9.2, M3): a move-marked change applies
// without a Confirm only onto a trusted proxy with exactly its trusted
// values, with host and protocol unchanged and the camera's TLS name under
// the new proxy's site. Anything else is held as before.
describe('TrustStore: the move rule', () => {
  const PRX = 'prx_PPPPPPPPPPPPPPPPPPPP', PRX2 = 'prx_QQQQQQQQQQQQQQQQQQQQ';
  const PIN = 'a'.repeat(64), PIN2 = 'b'.repeat(64), PIN3 = 'c'.repeat(64);
  const MOVE = 'mov_MMMMMMMMMMMMMMMMMMMM';
  const PT = (o: Partial<ProxyTrust> = {}): ProxyTrust => ({ proxyUrl: 'https://192.0.2.10:8443', caFingerprints: [PIN], proxyTlsServername: 'proxy.home.internal', ...o });
  const camV = (o: Partial<TrustValues> = {}) => V({ ...PT(), host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.home.internal', ...o });
  // The target proxy, site "shed".
  const shed = (o: Partial<SnapProxy> = {}): SnapProxy => ({ id: PRX2, name: 'shed', displayName: 'Shed', url: 'https://192.0.2.20:8443', adminUiUrl: null, tlsServername: 'proxy.shed.internal', caFingerprints: [PIN2], site: 'shed', tokens: [], ...o });
  const SHED = { proxyUrl: 'https://192.0.2.20:8443', caFingerprints: [PIN2], proxyTlsServername: 'proxy.shed.internal' };
  // cam1 as offered after the move onto the shed proxy.
  const moved = (o: Partial<TrustValues> = {}) => camV({ ...SHED, tlsServername: 'cam1.shed.internal', ...o });
  const mv = (o: Partial<{ moveId: string; proxyId: string; proxyCameraId: string; site: string | null }> = {}) => ({ moveId: MOVE, proxyId: PRX2, proxyCameraId: 'cam1', site: 'shed', ...o });
  const trustFile = (dir: string) => JSON.parse(readFileSync(join(dir, 'admin/trust.json'), 'utf8'));
  // cam1 confirmed on PRX; the shed proxy offered and (by default) trusted.
  const setup = (trustShed = true) => {
    const dir = dirOf();
    mkdirSync(join(dir, 'admin'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'admin/trust.json'), JSON.stringify({ v: 1, confirmed: { [`${ALPHA}/cam1`]: camV() }, keptOld: {}, proxies: {}, fileAccountId: ALPHA, log: [] }), { mode: 0o600 });
    const t = TrustStore.load(dir);
    t.proxyOffer(ALPHA, shed(), REV);
    if (trustShed) {
      const h = t.heldProxies(ALPHA).find((x) => x.proxyId === PRX2)!;
      t.confirmProxies('admin@example.org', ALPHA, [{ proxyId: PRX2, digest: h.digest }]);
    }
    return { dir, t };
  };
  afterEach(() => vi.restoreAllMocks());

  it('move to a trusted proxy applies without a hold and logs move (ids only)', () => {
    const { dir, t } = setup();
    const lines: unknown[][] = [];
    vi.spyOn(logger, 'info').mockImplementation(((...a: unknown[]) => void lines.push(a)) as never);
    expect(t.decide(ALPHA, 'cam1', moved(), mv())).toEqual({ use: moved(), confirmed: true, held: null });
    expect(t.held(ALPHA)).toEqual([]);
    // saved: a new store uses the new values without the move context
    expect(TrustStore.load(dir).decide(ALPHA, 'cam1', moved())).toEqual({ use: moved(), confirmed: true, held: null });
    const f = trustFile(dir);
    expect(f.log.at(-1)).toEqual({ at: expect.any(Number), email: '', accountId: ALPHA, camsIds: ['cam1'], action: 'move', moveId: MOVE });
    expect(JSON.stringify(f.log)).not.toMatch(/192\.0\.2|shed\.internal/);
    expect(statSync(join(dir, 'admin/trust.json')).mode & 0o777).toBe(0o600);
    const line = lines.find((l) => l[1] === 'camera_moved_trusted');
    expect(line?.[0]).toEqual({ accountId: ALPHA, camsId: 'cam1', proxyId: PRX2, moveId: MOVE });
  });

  it('a move clears a kept-old offer of the camera', async () => {
    const { t } = setup();
    t.decide(ALPHA, 'cam1', camV({ host: '192.0.2.99' }));
    await t.keepOld(ALPHA, [{ camsId: 'cam1', digest: t.offerDigest(ALPHA, 'cam1', REV)! }], REV, 'admin@example.org');
    t.decide(ALPHA, 'cam1', moved(), mv());
    expect(t.decide(ALPHA, 'cam1', camV({ host: '192.0.2.99' })).held).toMatchObject({ keptOld: false });
  });

  it('move to an untrusted proxy is held', () => {
    const { t } = setup(false);
    const d = t.decide(ALPHA, 'cam1', moved(), mv());
    expect(d.use).toEqual(camV());
    expect(d.held).toMatchObject({ camsId: 'cam1', isNew: false, offered: moved() });
  });

  it('move to a proxy with a held pin is held (Review Focus 1)', () => {
    const { t } = setup();
    // the shed proxy's pin changed: its own item is held
    t.proxyOffer(ALPHA, shed({ caFingerprints: [PIN3] }), REV);
    expect(t.heldProxies(ALPHA)).toHaveLength(1);
    // the camera offered with the new pin: not the trusted values
    expect(t.decide(ALPHA, 'cam1', moved({ caFingerprints: [PIN3] }), mv()).held).toMatchObject({ camsId: 'cam1' });
    // even with the old (trusted) pin while the proxy's offer is held
    const d = t.decide(ALPHA, 'cam1', moved(), mv());
    expect(d.use).toEqual(camV());
    expect(d.held).toMatchObject({ camsId: 'cam1' });
  });

  it('move to a proxy not offered in this snapshot is held', () => {
    const { t } = setup();
    t.forgetOffers();
    expect(t.decide(ALPHA, 'cam1', moved(), mv()).held).toMatchObject({ camsId: 'cam1' });
  });

  it('move with a changed host is held; a changed protocol too', () => {
    const { t } = setup();
    expect(t.decide(ALPHA, 'cam1', moved({ host: '192.0.2.99' }), mv()).held?.fields).toContain('host');
    expect(t.decide(ALPHA, 'cam1', moved({ protocol: 'http' }), mv()).held?.fields).toContain('protocol');
  });

  it('move with a TLS name not under the site is held', () => {
    const { t } = setup();
    for (const name of ['cam1.home.internal', 'cam1.shed.internal.evil.example', 'cam2.shed.internal', 'x.cam1.shed.internal', null]) {
      expect(t.decide(ALPHA, 'cam1', moved({ tlsServername: name }), mv()).held, String(name)).toMatchObject({ camsId: 'cam1' });
    }
    // the proxy has no site: nothing is under it
    expect(t.decide(ALPHA, 'cam1', moved(), mv({ site: null })).held).toMatchObject({ camsId: 'cam1' });
    // the move context names another proxy than the one offered
    expect(t.decide(ALPHA, 'cam1', moved(), mv({ proxyId: PRX })).held).toMatchObject({ camsId: 'cam1' });
  });

  it('a new camera is never confirmed by a move', () => {
    const { t } = setup();
    const d = t.decide(ALPHA, 'cam9', moved({ tlsServername: 'cam9.shed.internal' }), mv({ proxyCameraId: 'cam9' }));
    expect(d.confirmed).toBe(false);
    expect(d.held).toMatchObject({ isNew: true });
  });

  it('moveId does not excuse a host change (Review Focus 2)', () => {
    const { dir, t } = setup();
    t.decide(ALPHA, 'cam1', moved(), mv());
    // cams-admin keeps moveId set; a later unrelated host change is held
    const d = t.decide(ALPHA, 'cam1', moved({ host: '203.0.113.66' }), mv());
    expect(d.use).toEqual(moved());
    expect(d.held).toMatchObject({ fields: ['host'] });
    expect(TrustStore.load(dir).decide(ALPHA, 'cam1', moved()).held).toBeNull();
    expect(trustFile(dir).log.filter((e: { action: string }) => e.action === 'move')).toHaveLength(1);
  });

  it('without a move context a proxy change onto a trusted proxy is held as before', () => {
    const { t } = setup();
    expect(t.decide(ALPHA, 'cam1', moved()).held).toMatchObject({ camsId: 'cam1' });
  });
});
