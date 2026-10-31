// Camera trust for cameras behind a proxy that takes camera calls (spec
// 2026-10-30 §6.1): viewers trust proxies, not cameras. A camera's host,
// protocol and TLS name are never held; a new camera on a proxy this viewer
// trusts (and doesn't hold) is confirmed at once; no camera password.
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildFleet, type ApplyContext } from '../../server/admin/apply';
import type { AccountPart, SnapCamera, SnapProxy } from '../../server/admin/snapshot';
import { TrustStore, type TrustValues } from '../../server/admin/trust';
import { logger } from '../../server/logger';
import { ALPHA, ALPHA_REF } from '../helpers/fleet';

const REV = 'r:00000000000000a1';
const PRX = 'prx_PPPPPPPPPPPPPPPPPPPP', PRX3 = 'prx_RRRRRRRRRRRRRRRRRRRR';
const PIN = 'a'.repeat(64);
const TOKEN = 'T'.repeat(40);
const home: SnapProxy = { id: PRX, name: 'home', displayName: 'Home', url: 'https://192.0.2.10:8443', adminUiUrl: null, tlsServername: 'proxy.home.internal', caFingerprints: [PIN], site: 'home', tokens: [] };
const spare: SnapProxy = { id: PRX3, name: 'spare', displayName: 'Spare', url: 'https://192.0.2.30:8443', adminUiUrl: null, tlsServername: null, caFingerprints: [], site: null, tokens: [] };
const cam = (o: Partial<SnapCamera> = {}): SnapCamera => ({ id: 'cam_AAAAAAAAAAAAAAAAAAA1', camsId: 'cam1', name: 'Den', proxyId: PRX, proxyCameraId: 'cam1', host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.home.internal', cameraUser: 'cams', webUiUrl: null, webUiNote: null, moveId: null, move: null, ...o });
const confirmedHome: TrustValues = { proxyUrl: home.url, caFingerprints: [PIN], proxyTlsServername: 'proxy.home.internal', host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.home.internal' };
const part = (cameras: SnapCamera[]): AccountPart => ({ account: ALPHA_REF, revision: 1, users: [{ email: 'admin@example.org', role: 'admin', disabled: false }], proxies: [home, spare], cameras });

function store(o: { confirmed?: boolean } = {}): { t: TrustStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cams-viaproxy-trust-'));
  mkdirSync(join(dir, 'admin'), { recursive: true, mode: 0o700 });
  const file = join(dir, 'admin/trust.json');
  writeFileSync(file, JSON.stringify({
    v: 1, confirmed: o.confirmed === false ? {} : { [`${ALPHA}/cam1`]: confirmedHome }, keptOld: {}, fileAccountId: ALPHA, log: [],
    proxies: { [`${ALPHA}/${PRX}`]: { proxyUrl: home.url, caFingerprints: [PIN], proxyTlsServername: home.tlsServername } },
  }), { mode: 0o600 });
  return { t: TrustStore.load(dir), file };
}

function ctxOf(t: TrustStore, through: (url: string) => boolean) {
  const binds: [string, string][] = [];
  const asked: string[] = [];
  const ctx: ApplyContext = {
    credentials: (_a, c) => (asked.push(c), { ok: true, user: 'cams', password: 'pw' }),
    proxyToken: () => ({ token: TOKEN, adminToken: 'A'.repeat(40) }),
    trust: (a, c, o, move, via) => t.decide(a, c, o, move, via),
    trustedProxiesAt: (a, u) => t.trustedProxyIdsAt(a, u),
    proxyOffer: (a, p) => t.proxyOffer(a, p, REV),
    throughProxy: (_a, url) => through(url),
    bind: (s, e) => void binds.push([s, e]),
  };
  return { ctx, binds, asked };
}

describe('buildFleet for cameras behind a camera-calls proxy', () => {
  it('takes a changed camera host from the offer without holding it, and asks for no password', () => {
    const { t } = store();
    const { ctx, binds, asked } = ctxOf(t, (u) => u === home.url);
    const { accounts, held } = buildFleet([part([cam({ host: '192.0.2.99', tlsServername: null })])], ctx);
    expect(held).toEqual([]);
    const c = accounts[0].cameras[0];
    expect(c).toMatchObject({ host: '192.0.2.99', credentials: 'ok', password: '' });
    expect(c.tlsServername).toBeUndefined();
    expect(c.proxy).toMatchObject({ url: home.url, token: TOKEN });
    expect(asked).toEqual([]);
    expect(binds.map(([s]) => s)).not.toContain('pw');
  });

  it('confirms a new camera on a trusted proxy at once, logged as via-proxy', () => {
    const { t, file } = store({ confirmed: false });
    const info = vi.spyOn(logger, 'info');
    const { ctx } = ctxOf(t, (u) => u === home.url);
    const { accounts, held } = buildFleet([part([cam()])], ctx);
    expect(held).toEqual([]);
    expect(accounts[0].cameras[0]).toMatchObject({ credentials: 'ok', proxy: { url: home.url } });
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { log: { action: string }[] };
    expect(saved.log.at(-1)?.action).toBe('via-proxy');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ accountId: ALPHA, camsId: 'cam1', proxyId: PRX }), 'camera_trusted_via_proxy');
    info.mockRestore();
  });

  it('still holds a new camera on an untrusted proxy', () => {
    const { t } = store({ confirmed: false });
    const { ctx } = ctxOf(t, () => true);
    const { accounts, held } = buildFleet([part([cam({ proxyId: PRX3 })])], ctx);
    expect(held).toEqual([expect.objectContaining({ camsId: 'cam1', isNew: true })]);
    expect(accounts[0].cameras[0].credentials).toBe('unconfirmed');
  });

  it('still holds a new camera on a trusted proxy whose own offer is held', () => {
    const { t } = store({ confirmed: false });
    const { ctx } = ctxOf(t, () => true);
    // The home proxy offered with another pin: a held proxy item.
    const changed = { ...home, caFingerprints: ['c'.repeat(64)] };
    const { held } = buildFleet([{ ...part([cam()]), proxies: [changed, spare] }], ctx);
    expect(held).toEqual([expect.objectContaining({ camsId: 'cam1', isNew: true })]);
  });

  it('holds a proxy change of a through-proxy camera (proxies stay trusted by admins)', () => {
    const { t } = store();
    const { ctx } = ctxOf(t, () => true);
    const { accounts, held } = buildFleet([part([cam({ proxyId: PRX3 })])], ctx);
    expect(held).toEqual([expect.objectContaining({ camsId: 'cam1', fields: ['proxyUrl', 'caFingerprints', 'proxyTlsServername'] })]);
    expect(accounts[0].cameras[0].proxy?.url).toBe(home.url);
  });

  it('leaves a direct camera\'s holds as they were', () => {
    const { t } = store();
    const { ctx, asked } = ctxOf(t, () => false);
    const { accounts, held } = buildFleet([part([cam({ host: '192.0.2.99' })])], ctx);
    expect(held).toEqual([expect.objectContaining({ camsId: 'cam1', fields: ['host'] })]);
    expect(accounts[0].cameras[0]).toMatchObject({ host: '192.0.2.5', password: 'pw' });
    expect(asked).toEqual(['cam1']);
  });
});
