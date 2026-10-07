// Held trust changes (migration P4, M6, M §9.7, R4-7, R4-11; security review
// C1, I1, I2): connection data — proxy URL, pins, TLS names, camera host,
// protocol — is used only once an account admin confirmed it. A camera with
// no confirmed values (new, re-created, or under another account id) is held
// too, and nothing confirms by itself except the first-start seed.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TrustStore, trustValuesOf, type TrustValues } from '../../server/admin/trust';
import { ALPHA, ALPHA_REF } from '../helpers/fleet';

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
