// The fake cams-admin for the cams-admin-mode e2e server (playwright.config.ts):
// test/admin/fakeAdmin.ts on FAKE_ADMIN_PORT, with the cams instance already
// enrolled (its key file, credentials and a signed cache written into
// E2E_ADMIN_DATA before cams starts) and two accounts that both have "cam1".
// Test hooks on FAKE_ADMIN_HOOKS (127.0.0.1): POST /snapshot {homeHost},
// POST /reset. Never a real cams-admin.
import express from 'express';
import { generateKeyPairSync } from 'crypto';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { startFakeAdmin, signSnapshot, SERVER_KEY } from '../test/admin/fakeAdmin';
import { ADMIN_USERS, E2E_ADMIN_DATA, FAKE_ADMIN_HOOKS, FAKE_ADMIN_PORT } from './env';
import { FAKE_PROXY_PORT } from './fakeProxyData';

export const E2E_ACCOUNTS = { home: 'acc_00000000000000000HME', beta: 'acc_00000000000000000BTA' } as const;
const PRX = 'prx_00000000000000000FKP';
let revision = 1;

export function snapshot(o: { homeHost?: string } = {}): Record<string, unknown> {
  const cam = (id: string, camsId: string, name: string, host: string, proxyId: string | null) => ({
    id, camsId, name, proxyId, proxyCameraId: proxyId ? 'cam1' : null, host, protocol: 'http', tlsServername: null, cameraUser: 'e2e', webUiUrl: null, webUiNote: null,
  });
  return {
    v: 1, type: 'cams-config', instance: { id: 'cms_00000000000000000001', name: 'e2e', rotateBefore: null },
    revision: `r:${String(revision).padStart(16, '0')}`, generatedAt: 1_791_273_600_000 + revision,
    accounts: [
      { id: E2E_ACCOUNTS.beta, name: 'beta', displayName: 'Beta', revision, users: [{ email: ADMIN_USERS.both, role: 'viewer', disabled: false }],
        proxies: [], cameras: [cam('cam_000000000000000000B1', 'cam1', 'Porch', '127.0.0.1:8097', null)] },
      { id: E2E_ACCOUNTS.home, name: 'home', displayName: 'Home', revision,
        users: [{ email: ADMIN_USERS.both, role: 'admin', disabled: false }, { email: ADMIN_USERS.alpha, role: 'admin', disabled: false }],
        proxies: [{ id: PRX, name: 'fake', displayName: 'Fake proxy', url: `http://127.0.0.1:${FAKE_PROXY_PORT}`, adminUiUrl: null, tlsServername: null, caFingerprints: [], tokens: [] }],
        cameras: [cam('cam_000000000000000000H1', 'cam1', 'Den', o.homeHost ?? '127.0.0.1:8098', PRX)] },
    ],
  };
}

if (require.main === module) {
  void (async () => {
    const fake = await startFakeAdmin({ port: FAKE_ADMIN_PORT, instanceName: 'e2e', accounts: ['beta', 'home'] });
    // The instance, enrolled: its key, cams-admin's key, credentials, the cache.
    rmSync(E2E_ADMIN_DATA, { recursive: true, force: true });
    mkdirSync(join(E2E_ADMIN_DATA, 'admin'), { recursive: true, mode: 0o700 });
    chmodSync(join(E2E_ADMIN_DATA, 'admin'), 0o700);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    fake.publicKey = pub;
    fake.keyState = 'active';
    const key = { v: 1, url: fake.url, instanceId: fake.instanceId, instanceName: 'e2e', keyId: fake.keyId, privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey: pub, serverKeys: [SERVER_KEY.publicKey], serverKeyFingerprints: [fake.fingerprint], accounts: ['beta', 'home'], enrolledAt: Date.now() };
    writeFileSync(join(E2E_ADMIN_DATA, 'admin/key.json'), JSON.stringify(key), { mode: 0o600 });
    writeFileSync(join(E2E_ADMIN_DATA, 'credentials.json'), JSON.stringify({ v: 1, [`${E2E_ACCOUNTS.beta}/cam1`]: { user: 'e2e', password: 'e2e-not-a-real-password' } }), { mode: 0o600 });
    // Both cameras' connection data confirmed earlier by their admins (and the
    // file account recorded): no camera of this e2e waits on the held list.
    const tv = (proxyUrl: string | null, host: string) => ({ proxyUrl, caFingerprints: [], proxyTlsServername: null, host, protocol: 'http', tlsServername: null });
    writeFileSync(join(E2E_ADMIN_DATA, 'admin/trust.json'), JSON.stringify({ v: 1, fileAccountId: E2E_ACCOUNTS.home, confirmed: { [`${E2E_ACCOUNTS.home}/cam1`]: tv(`http://127.0.0.1:${FAKE_PROXY_PORT}`, '127.0.0.1:8098'), [`${E2E_ACCOUNTS.beta}/cam1`]: tv(null, '127.0.0.1:8097') }, keptOld: {}, log: [] }), { mode: 0o600 });
    fake.setSnapshot(snapshot());
    writeFileSync(join(E2E_ADMIN_DATA, 'admin/config-cache.json'), JSON.stringify(signSnapshot(snapshot())), { mode: 0o600 });
    const hooks = express();
    hooks.use(express.json());
    hooks.post('/snapshot', (req, res) => {
      revision++;
      fake.setSnapshot(snapshot(req.body as { homeHost?: string }));
      res.json({ revision });
    });
    hooks.listen(FAKE_ADMIN_HOOKS, '127.0.0.1');
    process.stdout.write(`fake cams-admin on ${fake.url} (hooks on ${FAKE_ADMIN_HOOKS})\n`);
  })();
}
