// buildFleet and the move rule (camera move, S §9.2, M3): every proxy of an
// account is offered to the trust store, and a camera's move context reaches
// decide(). A camera moved onto a trusted proxy is confirmed on the spot and
// gets its token and password, bound to the new endpoints only.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildFleet, type ApplyContext } from '../../server/admin/apply';
import type { AccountPart, SnapCamera, SnapProxy } from '../../server/admin/snapshot';
import { TrustStore, type TrustValues } from '../../server/admin/trust';
import { cameraEndpoint, proxyEndpoint } from '../../server/secretGuard';
import { ALPHA, ALPHA_REF } from '../helpers/fleet';

const REV = 'r:00000000000000a1';
const PRX = 'prx_PPPPPPPPPPPPPPPPPPPP', PRX2 = 'prx_QQQQQQQQQQQQQQQQQQQQ', PRX3 = 'prx_RRRRRRRRRRRRRRRRRRRR';
const PIN = 'a'.repeat(64), PIN2 = 'b'.repeat(64);
const MOVE = 'mov_MMMMMMMMMMMMMMMMMMMM';
const TOKEN = 'T'.repeat(40);
const home: SnapProxy = { id: PRX, name: 'home', displayName: 'Home', url: 'https://192.0.2.10:8443', adminUiUrl: null, tlsServername: 'proxy.home.internal', caFingerprints: [PIN], site: 'home', tokens: [] };
const shed: SnapProxy = { id: PRX2, name: 'shed', displayName: 'Shed', url: 'https://192.0.2.20:8443', adminUiUrl: null, tlsServername: 'proxy.shed.internal', caFingerprints: [PIN2], site: 'shed', tokens: [] };
const spare: SnapProxy = { ...shed, id: PRX3, name: 'spare', displayName: 'Spare', url: 'https://192.0.2.30:8443', tlsServername: null, caFingerprints: [], site: null };
const cam = (o: Partial<SnapCamera> = {}): SnapCamera => ({ id: 'cam_AAAAAAAAAAAAAAAAAAA1', camsId: 'cam1', name: 'Den', proxyId: PRX, proxyCameraId: 'cam1', host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.home.internal', cameraUser: 'cams', webUiUrl: null, webUiNote: null, moveId: null, ...o });
const confirmedHome: TrustValues = { proxyUrl: 'https://192.0.2.10:8443', caFingerprints: [PIN], proxyTlsServername: 'proxy.home.internal', host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.home.internal' };
const part = (cameras: SnapCamera[]): AccountPart => ({ account: ALPHA_REF, revision: 1, users: [{ email: 'admin@example.org', role: 'admin', disabled: false }], proxies: [home, shed, spare], cameras });

// cam1 confirmed on the home proxy; both home and shed trusted.
function store(): TrustStore {
  const dir = mkdtempSync(join(tmpdir(), 'cams-apply-'));
  mkdirSync(join(dir, 'admin'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'admin/trust.json'), JSON.stringify({
    v: 1, confirmed: { [`${ALPHA}/cam1`]: confirmedHome }, keptOld: {}, fileAccountId: ALPHA, log: [],
    proxies: { [`${ALPHA}/${PRX}`]: { proxyUrl: home.url, caFingerprints: [PIN], proxyTlsServername: home.tlsServername }, [`${ALPHA}/${PRX2}`]: { proxyUrl: shed.url, caFingerprints: [PIN2], proxyTlsServername: shed.tlsServername } },
  }), { mode: 0o600 });
  return TrustStore.load(dir);
}

function ctxOf(t: TrustStore) {
  const binds: [string, string][] = [];
  const offered: string[] = [];
  const ctx: ApplyContext = {
    credentials: () => ({ ok: true, user: 'cams', password: 'pw' }),
    proxyToken: () => ({ token: TOKEN }),
    trust: (a, c, o, move) => t.decide(a, c, o, move),
    proxyOffer: (a, p) => {
      offered.push(p.id);
      t.proxyOffer(a, p, REV);
    },
    bind: (s, e) => void binds.push([s, e]),
  };
  return { ctx, binds, offered };
}

describe('buildFleet: the move rule', () => {
  it('offers every proxy of the account, cameras or not', () => {
    const t = store();
    const { ctx, offered } = ctxOf(t);
    buildFleet([part([cam()])], ctx);
    expect(offered).toEqual([PRX, PRX2, PRX3]);
    expect(t.heldProxies(ALPHA).map((h) => h.proxyId)).toEqual([PRX3]); // the untrusted spare
  });

  it('a move-confirmed camera gets its password binding', () => {
    const t = store();
    const { ctx, binds } = ctxOf(t);
    const { accounts, held } = buildFleet([part([cam({ proxyId: PRX2, tlsServername: 'cam1.shed.internal', moveId: MOVE })])], ctx);
    expect(held).toEqual([]);
    const c = accounts[0].cameras[0];
    expect(c.credentials).toBe('ok');
    expect(c.password).toBe('pw');
    expect(c.tlsServername).toBe('cam1.shed.internal');
    expect(c.proxy).toMatchObject({ url: shed.url, token: TOKEN, camera: 'cam1', caFingerprint: [PIN2], tlsServername: 'proxy.shed.internal', proxyId: PRX2 });
    expect(binds).toEqual([
      [TOKEN, proxyEndpoint({ url: shed.url!, pins: [PIN2], tlsServername: 'proxy.shed.internal' })],
      ['pw', cameraEndpoint({ protocol: 'https', host: '192.0.2.5', tlsServername: 'cam1.shed.internal', pins: [PIN2] })],
    ]);
  });

  it('the same change without moveId is held: the camera stays on the confirmed proxy', () => {
    const t = store();
    const { ctx, binds } = ctxOf(t);
    const { accounts, held } = buildFleet([part([cam({ proxyId: PRX2, tlsServername: 'cam1.shed.internal' })])], ctx);
    expect(held).toEqual([expect.objectContaining({ camsId: 'cam1', isNew: false })]);
    const c = accounts[0].cameras[0];
    expect(c.proxy?.url).toBe(home.url);
    expect(c.tlsServername).toBe('cam1.home.internal');
    expect(binds.some(([, e]) => e.includes('192.0.2.20') || e.includes('shed'))).toBe(false);
  });

  it('a move onto a proxy without a site (or untrusted) is held', () => {
    const t = store();
    const { ctx } = ctxOf(t);
    const { held } = buildFleet([part([cam({ proxyId: PRX3, tlsServername: 'cam1.spare.internal', moveId: MOVE })])], ctx);
    expect(held).toEqual([expect.objectContaining({ camsId: 'cam1' })]);
  });
});
