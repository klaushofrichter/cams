// The snapshot (migration P4, M §9.3, R4-16): verified (signature, this
// instance), then cams's own camera rules per account.
import { describe, expect, it } from 'vitest';
import vectors from '../../contract/cams-v1/vectors.json';
import { accountParts, verifySnapshot } from '../../server/admin/snapshot';
import { buildFleet } from '../../server/admin/apply';
import { camKey } from '../../server/fleet';
import { ALPHA, BETA } from '../helpers/fleet';
import { signSnapshot } from './fakeAdmin';
import { INSTANCE, PRX_A, snapCamera, twoAccountsSnapshot } from './snapshots';

const KEYS = [vectors.keys.server.publicKey];

describe('verifySnapshot', () => {
  it('the vectors snapshot verifies; a changed byte, another key, another instance id → refused', () => {
    const s = { ...vectors.snapshots[0].snapshot, sig: vectors.snapshots[0].sig };
    const id = (s.instance as { id: string }).id;
    expect(verifySnapshot(s, KEYS, id)).toMatchObject({ ok: true });
    expect(verifySnapshot({ ...s, generatedAt: s.generatedAt + 1 }, KEYS, id)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySnapshot(s, [vectors.keys.other.publicKey], id)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySnapshot(s, KEYS, 'cms_99999999999999999999')).toEqual({ ok: false, reason: 'wrong_instance' });
    expect(verifySnapshot({ ...s, accounts: 'x' }, KEYS, id)).toEqual({ ok: false, reason: 'shape' });
    expect(verifySnapshot(null, KEYS, id)).toEqual({ ok: false, reason: 'shape' });
  });
});

describe('accountParts', () => {
  it('a valid two-account snapshot gives two parts', () => {
    const v = verifySnapshot(signSnapshot(twoAccountsSnapshot()), KEYS, INSTANCE);
    if (!v.ok) throw new Error(v.reason);
    const p = accountParts(v.snapshot);
    expect(p.failed).toEqual([]);
    expect(p.ok.map((x) => x.account.id)).toEqual([ALPHA, BETA]);
    expect(p.ok[0].users).toEqual([{ email: 'both@example.org', role: 'admin', disabled: false }, { email: 'alpha@example.org', role: 'admin', disabled: false }]);
  });

  it('an invalid camera (protocol "ftp", host from-proxy without pin or TLS name, http proxy URL with pins not on loopback) fails only its account', () => {
    const cases: Record<string, unknown>[] = [
      { alphaCameras: [snapCamera({ protocol: 'ftp', proxyId: PRX_A })] },
      { alphaCameras: [snapCamera({ host: 'from-proxy', protocol: 'https', proxyId: PRX_A })] },
      { alphaUrl: 'http://192.0.2.9:8480', alphaProxyExtra: { caFingerprints: [`SHA256:${'A'.repeat(64)}`] }, alphaCameras: [snapCamera({ proxyId: PRX_A })] },
      { alphaCameras: [snapCamera({ camsId: 'Bad Id' })] },
      { alphaCameras: [snapCamera(), snapCamera({ id: 'cam_X' })] }, // duplicate camsId
    ];
    for (const c of cases) {
      const v = verifySnapshot(signSnapshot(twoAccountsSnapshot(c)), KEYS, INSTANCE);
      if (!v.ok) throw new Error(v.reason);
      const p = accountParts(v.snapshot);
      expect([JSON.stringify(c).slice(0, 60), p.failed.map((f) => f.accountId)]).toEqual([JSON.stringify(c).slice(0, 60), [ALPHA]]);
      expect(p.ok.map((x) => x.account.id)).toEqual([BETA]);
      expect(p.failed[0].detail.length).toBeLessThanOrEqual(200);
    }
  });

  it('an account name outside cams-admin\'s rule (a slash, spaces, upper case) fails its account', () => {
    for (const homeName of ['a/b', 'a b', 'Alpha', 'x'.repeat(40)]) {
      const v = verifySnapshot(signSnapshot(twoAccountsSnapshot({ homeName })), KEYS, INSTANCE);
      if (!v.ok) throw new Error(v.reason);
      expect([homeName, accountParts(v.snapshot).failed.map((f) => f.accountId)]).toEqual([homeName, [ALPHA]]);
    }
  });

  const parts = (o: Record<string, unknown>) => {
    const v = verifySnapshot(signSnapshot(twoAccountsSnapshot(o)), KEYS, INSTANCE);
    if (!v.ok) throw new Error(v.reason);
    return accountParts(v.snapshot);
  };
  const MOVE = 'mv_0123456789ABCDEFGHJK';

  it('camera moveId is read and validated', () => {
    const p = parts({ alphaCameras: [snapCamera({ proxyId: PRX_A, proxyCameraId: 'cam1', moveId: MOVE })] });
    expect(p.failed).toEqual([]);
    expect(p.ok[0].cameras[0].moveId).toBe(MOVE);
    expect(p.ok[1].cameras[0].moveId).toBeNull();
  });

  it('a bad moveId fails the account (last good part kept)', () => {
    for (const moveId of ['mv_short', 'MV_0123456789ABCDEFGHJK', 'mv_0123456789ABCDEFGHJU', 5, '']) {
      const p = parts({ alphaCameras: [snapCamera({ proxyId: PRX_A, proxyCameraId: 'cam1', moveId })] });
      expect([String(moveId), p.failed.map((f) => f.accountId)]).toEqual([String(moveId), [ALPHA]]);
      expect(p.ok.map((x) => x.account.id)).toEqual([BETA]);
    }
  });

  it('proxy site is read; a bad site fails the account', () => {
    expect(parts({}).ok[0].proxies[0].site).toBe('alpha');
    expect(parts({ alphaProxyExtra: { site: null } }).ok[0].proxies[0].site).toBeNull();
    expect(parts({ alphaProxyExtra: { site: 'a'.repeat(31) } }).failed).toEqual([]);
    for (const site of ['Home', '-x', 'a b', 'a'.repeat(32), '', 7]) {
      expect([String(site), parts({ alphaProxyExtra: { site } }).failed.map((f) => f.accountId)]).toEqual([String(site), [ALPHA]]);
    }
  });

  it('a cached snapshot without site and moveId still applies, reading both as null', () => {
    const raw = twoAccountsSnapshot() as { accounts: { proxies: Record<string, unknown>[]; cameras: Record<string, unknown>[] }[] };
    for (const a of raw.accounts) {
      for (const x of a.proxies) delete x.site;
      for (const x of a.cameras) delete x.moveId;
    }
    const v = verifySnapshot(signSnapshot(raw as unknown as Record<string, unknown>), KEYS, INSTANCE);
    if (!v.ok) throw new Error(v.reason);
    const p = accountParts(v.snapshot);
    expect(p.failed).toEqual([]);
    expect(p.ok[0].proxies[0].site).toBeNull();
    expect(p.ok[0].cameras[0].moveId).toBeNull();
  });

  it('a bad user list fails its account', () => {
    const v = verifySnapshot(signSnapshot(twoAccountsSnapshot({ users: { b: [{ email: 'x@example.org', role: 'owner', disabled: false }] } })), KEYS, INSTANCE);
    if (!v.ok) throw new Error(v.reason);
    expect(accountParts(v.snapshot).failed.map((f) => f.accountId)).toEqual([BETA]);
  });
});

describe('buildFleet', () => {
  it('builds keyed cameras with the snapshot\'s proxy URL, the proxy\'s camera id and the credentials found locally', () => {
    const v = verifySnapshot(signSnapshot(twoAccountsSnapshot()), KEYS, INSTANCE);
    if (!v.ok) throw new Error(v.reason);
    const { ok } = accountParts(v.snapshot);
    const { accounts, problems } = buildFleet(ok, {
      credentials: (acc, camsId) => (acc === ALPHA ? { ok: true, user: 'cams', password: `pw-${camsId}` } : { ok: false, problem: 'missing', user: null }),
      proxyToken: (accountId) => (accountId === ALPHA ? { token: 't'.repeat(40) } : undefined),
    });
    const a = accounts.find((x) => x.id === ALPHA)!.cameras[0];
    expect(a).toMatchObject({ id: camKey(ALPHA, 'cam1'), camsId: 'cam1', accountId: ALPHA, name: 'Alpha cam', credentials: 'ok', password: 'pw-cam1', proxy: { url: 'http://127.0.0.1:1/alpha', token: 't'.repeat(40), camera: 'cam1', proxyId: PRX_A } });
    const b = accounts.find((x) => x.id === BETA)!.cameras[0];
    expect(b).toMatchObject({ credentials: 'missing', password: '' });
    expect(b.proxy).toBeUndefined(); // no token for Beta's proxy yet
    expect(problems.map((p) => p.code)).toContain('proxy_token_missing');
    expect(accounts.find((x) => x.id === BETA)!.users).toEqual([{ email: 'both@example.org', role: 'viewer', disabled: false }]);
  });
});
