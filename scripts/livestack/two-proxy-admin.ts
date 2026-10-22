// The two-proxy stack's fake cams-admin (start-two-proxy-stack.sh
// --start-admin; docs/livestack.md, "Two proxies", the camera move): the
// test double test/admin/fakeAdmin.ts as a process on 127.0.0.1, for a
// second cams in cams-admin mode. Never a real cams-admin, S3 or Google.
//
// Before that cams starts, it writes the instance as enrolled into
// TWOPROXY_ADMIN_DATA: its key file and a signed cache of the first snapshot.
// No trust.json: cams seeds it at its first start from its CAMERAS_FILE (the
// file account's camera confirmed on proxy A) and trusts proxy A once (M2).
//
// One account ("home", the file account), one camera "mover" (camsId), whose
// host is cam-sim B's: the snapshot steps (POST /step on the hooks port)
//   base    proxy A only; mover on proxy A (its cam1)
//   proxyB  proxy B added (site "siteb"): new, held until an admin confirms
//   moved   mover on proxy B (its cam1), moveId set, TLS name
//           cam1.siteb.internal: the move rule applies it without a hold
// GET /reports: the last report's appliedRevision, held and heldProxies.
// cams's own tokens (POST /cams/v1/tokens) are listed on their proxy in the
// snapshot; GET /tokens lists them (ids and states, no hashes), POST
// /activate {proxyId} makes that proxy's client tokens active in a new
// revision (cams-admin's tokens.apply done: start-two-proxy-stack.sh
// --admin-token-to-proxy-b installs the token on the proxy first).
// Every value here is test data (ids made up for this file, loopback URLs).
import express from 'express';
import { generateKeyPairSync } from 'crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SERVER_KEY, signSnapshot, startFakeAdmin, type FakeTokenRow } from '../../test/admin/fakeAdmin';
import { MOVE } from './two-proxy-env';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const PORT = Number(need('TWOPROXY_ADMIN_PORT'));
const HOOKS = Number(need('TWOPROXY_ADMIN_HOOKS'));
const DATA = need('TWOPROXY_ADMIN_DATA');
const PROXY_A_URL = need('TWOPROXY_PROXY_A_URL');
const PROXY_B_URL = need('TWOPROXY_PROXY_B_URL');
const MOVER_HOST = need('TWOPROXY_MOVER_HOST'); // cam-sim B's http host:port
const ADMIN_EMAIL = need('TWOPROXY_ADMIN_EMAIL');

const { ACCOUNT, PROXY_A, PROXY_B, MOVE_ID, CAMS_ID } = MOVE;

type Step = 'base' | 'proxyB' | 'moved';
let revision = 1;
let step: Step = 'base';
let tokens: FakeTokenRow[] = [];

function snapshot(): Record<string, unknown> {
  const listed = (proxyId: string) => tokens.filter((t) => t.proxyId === proxyId).map((t) => ({ id: t.tokenId, kind: t.kind, state: t.state, retireAt: t.retireAt }));
  const proxy = (id: string, name: string, displayName: string, url: string, site: string) => ({ id, name, displayName, url, adminUiUrl: null, tlsServername: null, caFingerprints: [], site, tokens: listed(id) });
  const moved = step === 'moved';
  return {
    v: 1,
    type: 'cams-config',
    instance: { id: 'cms_00000000000000000001', name: 'livestack', rotateBefore: null },
    revision: `r:${String(revision).padStart(16, '0')}`,
    generatedAt: 1_791_273_600_000 + revision,
    accounts: [
      {
        id: ACCOUNT, name: 'home', displayName: 'Home', revision,
        users: [{ email: ADMIN_EMAIL, role: 'admin', disabled: false }],
        proxies: [proxy(PROXY_A, 'proxy-a', 'Proxy A', PROXY_A_URL, 'sitea'), ...(step !== 'base' ? [proxy(PROXY_B, 'proxy-b', 'Proxy B', PROXY_B_URL, 'siteb')] : [])],
        cameras: [{
          id: 'cam_00000000000000000LSMV', camsId: CAMS_ID, name: 'Mover',
          proxyId: moved ? PROXY_B : PROXY_A, proxyCameraId: 'cam1',
          host: MOVER_HOST, protocol: 'http', tlsServername: moved ? 'cam1.siteb.internal' : null,
          cameraUser: 'cams', webUiUrl: null, webUiNote: 'Simulated camera (livestack, camera move)', moveId: moved ? MOVE_ID : null,
        }],
      },
    ],
  };
}

void (async () => {
  const fake = await startFakeAdmin({ port: PORT, instanceName: 'livestack', accounts: ['home'] });
  tokens = fake.tokens; // the same rows the fake's POST /tokens adds to
  // The instance, enrolled: its key, cams-admin's key, the signed cache.
  mkdirSync(join(DATA, 'admin'), { recursive: true, mode: 0o700 });
  chmodSync(DATA, 0o700);
  chmodSync(join(DATA, 'admin'), 0o700);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  fake.publicKey = pub;
  fake.keyState = 'active';
  const key = { v: 1, url: fake.url, instanceId: fake.instanceId, instanceName: 'livestack', keyId: fake.keyId, privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey: pub, serverKeys: [SERVER_KEY.publicKey], serverKeyFingerprints: [fake.fingerprint], accounts: ['home'], enrolledAt: Date.now() };
  writeFileSync(join(DATA, 'admin/key.json'), JSON.stringify(key), { mode: 0o600 });
  fake.setSnapshot(snapshot());
  writeFileSync(join(DATA, 'admin/config-cache.json'), JSON.stringify(signSnapshot(snapshot())), { mode: 0o600 });

  const hooks = express();
  hooks.use(express.json());
  hooks.post('/step', (req, res) => {
    const s = (req.body as { step?: string }).step;
    if (s !== 'base' && s !== 'proxyB' && s !== 'moved') return void res.status(400).json({ error: 'step is base, proxyB or moved' });
    step = s;
    revision++;
    fake.setSnapshot(snapshot());
    res.json({ step, revision: `r:${String(revision).padStart(16, '0')}` });
  });
  hooks.get('/tokens', (_req, res) => {
    res.json(fake.tokens.map((t) => ({ tokenId: t.tokenId, proxyId: t.proxyId, kind: t.kind, state: t.state })));
  });
  hooks.post('/activate', (req, res) => {
    const proxyId = (req.body as { proxyId?: string }).proxyId;
    const rows = fake.tokens.filter((t) => t.proxyId === proxyId && t.kind === 'client' && t.state === 'pending');
    if (!rows.length) return void res.status(404).json({ error: 'no pending client token for that proxy' });
    for (const t of rows) t.state = 'active';
    revision++;
    fake.setSnapshot(snapshot());
    res.json({ activated: rows.map((t) => t.tokenId), revision: `r:${String(revision).padStart(16, '0')}` });
  });
  hooks.get('/reports', (_req, res) => {
    const last = fake.reports.at(-1) as { appliedRevision?: unknown; held?: unknown; heldProxies?: unknown } | undefined;
    res.json({ count: fake.reports.length, last: last ? { appliedRevision: last.appliedRevision, held: last.held, heldProxies: last.heldProxies } : null });
  });
  hooks.listen(HOOKS, '127.0.0.1');
  process.stdout.write(`fake cams-admin on ${fake.url} (hooks on 127.0.0.1:${HOOKS})\n`);
  const stop = () => void fake.stop().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})();
