// Held trust changes (migration P4, M6, M §9.7, R4-7, R4-11): connection
// data that changed in cams-admin waits until an account admin confirms.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TrustStore, trustValuesOf, type TrustValues } from '../../server/admin/trust';
import { ALPHA, ALPHA_REF } from '../helpers/fleet';

const dirOf = () => mkdtempSync(join(tmpdir(), 'cams-trust-'));
const V = (o: Partial<TrustValues> = {}): TrustValues => ({ proxyUrl: 'http://127.0.0.1:8480', caFingerprints: [], proxyTlsServername: null, host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.example.net', ...o });

describe('TrustStore', () => {
  it('seeded from CAMERAS_FILE at the first cams-admin start: an equal snapshot holds nothing', async () => {
    const t = TrustStore.load(dirOf());
    expect(t.exists()).toBe(false);
    t.seedFromFile(ALPHA_REF, [{ id: 'cam1', name: 'Den', host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.example.net', user: 'u', password: 'p', proxy: { url: 'http://127.0.0.1:8480/', token: 't'.repeat(40) } }]);
    expect(t.exists()).toBe(true);
    expect(t.decide(ALPHA, 'cam1', V(), true)).toEqual({ use: V(), held: null });
  });

  it('a changed host is held: the camera keeps the old host, the admin sees from → to; Confirm moves it', async () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    t.decide(ALPHA, 'cam1', V(), true); // new with credentials: confirmed at once
    const d = t.decide(ALPHA, 'cam1', V({ host: '192.0.2.99' }), true);
    expect(d.use).toEqual(V());
    expect(d.held).toMatchObject({ accountId: ALPHA, camsId: 'cam1', fields: ['host'], confirmed: V(), offered: V({ host: '192.0.2.99' }), keptOld: false });
    expect(t.held(ALPHA)).toHaveLength(1);
    await t.confirm(ALPHA, ['cam1'], 'admin@example.org');
    expect(t.decide(ALPHA, 'cam1', V({ host: '192.0.2.99' }), true)).toEqual({ use: V({ host: '192.0.2.99' }), held: null });
    expect(TrustStore.load(dir).decide(ALPHA, 'cam1', V({ host: '192.0.2.99' }), true).held).toBeNull(); // persisted
    const file = JSON.parse(readFileSync(join(dir, 'admin/trust.json'), 'utf8'));
    expect(file.log.at(-1)).toMatchObject({ email: 'admin@example.org', accountId: ALPHA, camsIds: ['cam1'], action: 'confirm' });
  });

  it('a changed proxy URL holds every camera of that proxy, and the old URL is used with the old pins (never a mix)', () => {
    const t = TrustStore.load(dirOf());
    const pin = `SHA256:${'A'.repeat(64)}`;
    for (const c of ['cam1', 'cam2']) t.decide(ALPHA, c, V({ caFingerprints: [pin] }), true);
    for (const c of ['cam1', 'cam2']) {
      const d = t.decide(ALPHA, c, V({ proxyUrl: 'https://evil.example:8443', caFingerprints: [`SHA256:${'B'.repeat(64)}`] }), true);
      expect(d.use).toEqual(V({ caFingerprints: [pin] }));
      expect(d.held?.fields).toEqual(['proxyUrl', 'caFingerprints']);
    }
  });

  it('https → http is held (R4-7)', () => {
    const t = TrustStore.load(dirOf());
    t.decide(ALPHA, 'cam1', V(), true);
    expect(t.decide(ALPHA, 'cam1', V({ protocol: 'http' }), true).held?.fields).toEqual(['protocol']);
  });

  it('a camera deleted and re-created with the same camsId and another host is held, not "new"', () => {
    const t = TrustStore.load(dirOf());
    t.decide(ALPHA, 'cam1', V(), true);
    t.forgetOffers(); // a snapshot without the camera
    expect(t.decide(ALPHA, 'cam1', V({ host: '198.51.100.7' }), true).held?.fields).toEqual(['host']);
  });

  it('a new camera without local credentials: applied, no login; with credentials: confirmed at once', () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    expect(t.decide(ALPHA, 'cam9', V(), false)).toEqual({ use: V(), held: null });
    expect(TrustStore.load(dir).decide(ALPHA, 'cam9', V({ host: 'x' }), false)).toEqual({ use: V({ host: 'x' }), held: null }); // nothing confirmed yet
    t.decide(ALPHA, 'cam9', V(), true);
    expect(t.decide(ALPHA, 'cam9', V({ host: 'x' }), true).held?.fields).toEqual(['host']);
  });

  it('Keep old: the banner hides, the report lists keptOld, a new different offer shows again', async () => {
    const t = TrustStore.load(dirOf());
    t.decide(ALPHA, 'cam1', V(), true);
    t.decide(ALPHA, 'cam1', V({ host: 'b' }), true);
    await t.keepOld(ALPHA, ['cam1'], 'admin@example.org');
    const d = t.decide(ALPHA, 'cam1', V({ host: 'b' }), true);
    expect(d.use).toEqual(V());
    expect(d.held).toMatchObject({ keptOld: true });
    expect(t.held(ALPHA).filter((h) => !h.keptOld)).toEqual([]);
    expect(t.decide(ALPHA, 'cam1', V({ host: 'c' }), true).held).toMatchObject({ keptOld: false, fields: ['host'] });
  });

  it('trust.json is 600; a corrupt one stops a cams-admin-mode start with a message naming the file', () => {
    const dir = dirOf();
    const t = TrustStore.load(dir);
    t.decide(ALPHA, 'cam1', V(), true);
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
