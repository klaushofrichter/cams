// No secret leaves cams for an endpoint an admin hasn't confirmed (security
// review C1, I2): proxy tokens are bound to the confirmed proxy endpoint
// (URL, pins, TLS name), camera passwords to the confirmed camera endpoint
// (protocol, host, TLS name, pins). The guard sits where requests attach the
// secret: the proxy client and the camera client.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import vectors from '../../contract/cams-v1/vectors.json';
import { buildFleet } from '../../server/admin/apply';
import { accountParts, verifySnapshot } from '../../server/admin/snapshot';
import { TrustStore } from '../../server/admin/trust';
import { setCameras } from '../../server/cameraRegistry';
import { camKey, setFleet } from '../../server/fleet';
import { ProxyClient, ProxyError } from '../../server/proxy/client';
import { getClient, requireClient, resetClients } from '../../server/reolink/clients';
import { bindSecret, clearSecretBindings, proxyEndpoint, setSecretGuard } from '../../server/secretGuard';
import { ALPHA } from '../helpers/fleet';
import { startFakeProxy, FAKE_TOKEN, type FakeProxy } from '../proxy/fakeProxy';
import { signSnapshot } from './fakeAdmin';
import { INSTANCE, PRX_A, snapCamera, twoAccountsSnapshot } from './snapshots';

const SECRET = 'S'.repeat(40), ADMIN = 'A'.repeat(40);
const partsOf = (o: Parameters<typeof twoAccountsSnapshot>[0]) => {
  const v = verifySnapshot(signSnapshot(twoAccountsSnapshot(o)), [vectors.keys.server.publicKey], INSTANCE);
  if (!v.ok) throw new Error(v.reason);
  return accountParts(v.snapshot).ok;
};
afterEach(() => {
  setSecretGuard(false);
  clearSecretBindings();
  setCameras([]);
  resetClients();
});

describe('C1: a held proxy and a new camera on it', () => {
  it('two cameras on one proxy, the URL changed and one camera new: the new one gets no token and no password; the held one keeps the confirmed URL; tokens are bound to it only', async () => {
    const trust = TrustStore.load(mkdtempSync(join(tmpdir(), 'cams-guard-')));
    const base = { alphaUrl: 'https://good.example:8443', alphaCameras: [snapCamera({ id: 'cam_1', camsId: 'cam1', name: 'One', proxyId: PRX_A, protocol: 'https', tlsServername: 'cam1.example.net', host: '192.0.2.5' })] };
    const ctx = (parts: ReturnType<typeof partsOf>) => ({
      credentials: () => ({ ok: true as const, user: 'cams', password: 'pw' }),
      proxyToken: () => ({ token: SECRET, adminToken: ADMIN }),
      trust: (a: string, c: string, o: Parameters<TrustStore['decide']>[2]) => trust.decide(a, c, o),
      bind: bindSecret,
    });
    // cam1 confirmed at https://good
    trust.decide(ALPHA, 'cam1', buildFleet(partsOf(base), ctx(partsOf(base))).held[0].offered);
    await trust.confirm(ALPHA, [{ camsId: 'cam1', digest: trust.offerDigest(ALPHA, 'cam1', 'r')! }], 'r', 'a@example.org');
    // cams-admin moves the proxy and adds cam2 on it
    const evil = partsOf({ alphaUrl: 'https://evil.example', alphaCameras: [...base.alphaCameras, snapCamera({ id: 'cam_2', camsId: 'cam2', name: 'Two', proxyId: PRX_A, protocol: 'https', tlsServername: 'cam2.example.net', host: '192.0.2.6' })] });
    clearSecretBindings();
    const { accounts, held } = buildFleet(evil, ctx(evil));
    const cams = accounts.find((a) => a.id === ALPHA)!.cameras;
    const one = cams.find((c) => c.camsId === 'cam1')!, two = cams.find((c) => c.camsId === 'cam2')!;
    expect(one.proxy?.url).toBe('https://good.example:8443');
    expect(two.proxy).toBeUndefined();
    expect(two.password).toBe('');
    expect(two.credentials).toBe('unconfirmed');
    expect(JSON.stringify(two)).not.toContain(SECRET);
    expect(held.filter((h) => h.accountId === ALPHA).map((h) => [h.camsId, h.isNew])).toEqual([['cam1', false], ['cam2', true]]);
    setSecretGuard(true);
    await expect(new ProxyClient({ url: 'https://evil.example', token: SECRET }).open('/api/cameras')).rejects.toMatchObject({ code: 'proxy_unconfirmed' });
  });
});

describe('the guard at the proxy client', () => {
  let fake: FakeProxy;
  beforeEach(async () => {
    fake = await startFakeProxy();
  });
  afterEach(() => fake.stop());

  it('a token goes only to the endpoint it is bound to; nothing is sent elsewhere', async () => {
    setSecretGuard(true);
    const before = fake.requests.length;
    await expect(new ProxyClient({ url: fake.url, token: FAKE_TOKEN }).open('/api/cameras')).rejects.toBeInstanceOf(ProxyError);
    expect(fake.requests.length).toBe(before); // never reached the proxy
    bindSecret(FAKE_TOKEN, proxyEndpoint({ url: fake.url, pins: null, tlsServername: null }));
    expect((await new ProxyClient({ url: fake.url, token: FAKE_TOKEN }).open('/api/cameras')).status).toBe(200);
    expect(fake.requests.length).toBe(before + 1);
    // the same token, other pins: refused
    await expect(new ProxyClient({ url: fake.url, token: FAKE_TOKEN }, { endpoint: { pins: ['a'.repeat(64)], tlsServername: null } }).open('/api/cameras')).rejects.toMatchObject({ code: 'proxy_unconfirmed' });
  });

  it('off (file mode): as before', async () => {
    expect((await new ProxyClient({ url: fake.url, token: FAKE_TOKEN }).open('/api/cameras')).status).toBe(200);
  });
});

describe('the guard at the camera client', () => {
  const cam = (o: Record<string, unknown> = {}) => ({ id: 'cam1', name: 'Den', host: '192.0.2.5', protocol: 'https' as const, tlsServername: 'cam1.example.net', user: 'cams', password: 'pw', ...o });
  it('a password only for the confirmed camera endpoint; never over unverified TLS', () => {
    setFleet([{ id: ALPHA, name: 'alpha', displayName: 'Alpha', users: [], cameras: [{ ...cam(), id: camKey(ALPHA, 'cam1'), camsId: 'cam1', accountId: ALPHA, credentials: 'ok' }] }]);
    setSecretGuard(true);
    expect(getClient(camKey(ALPHA, 'cam1'))).toBeUndefined();
    expect(() => requireClient(camKey(ALPHA, 'cam1'))).toThrow(expect.objectContaining({ code: 'camera_unconfirmed' }));
    bindSecret('pw', 'camera|https|192.0.2.5|cam1.example.net|');
    expect(getClient(camKey(ALPHA, 'cam1'))).toBeDefined();
    resetClients();
    // https without a TLS name or pins: unverified, refused even when bound
    setFleet([{ id: ALPHA, name: 'alpha', displayName: 'Alpha', users: [], cameras: [{ ...cam({ tlsServername: undefined }), id: camKey(ALPHA, 'cam1'), camsId: 'cam1', accountId: ALPHA, credentials: 'ok' }] }]);
    bindSecret('pw', 'camera|https|192.0.2.5||');
    expect(() => requireClient(camKey(ALPHA, 'cam1'))).toThrow(expect.objectContaining({ code: 'camera_unverified_tls' }));
  });
});
