// The held-change routes (migration P4, M §9.7): account admins see what
// cams-admin changed (from → to) and confirm or keep the old values;
// viewers can't, and no account sees another's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { writeCache } from '../server/admin/cache';
import { enroll } from '../server/admin/enroll';
import { writeKeyFile } from '../server/admin/keyfile';
import type { Snapshot } from '../server/admin/snapshot';
import { createApp } from '../server/app';
import { cameraHost, getCamera, setCameras } from '../server/cameraRegistry';
import { pullNow, startConfig, stopConfig } from '../server/configSource';
import { camKey, setFileAccountId, DEFAULT_FILE_ACCOUNT_ID } from '../server/fleet';
import { loadProxyState } from '../server/proxyState';
import { ALPHA, BETA, cookieFor } from './helpers/fleet';
import { signSnapshot, startFakeAdmin, type FakeAdmin } from './admin/fakeAdmin';
import { twoAccountsSnapshot } from './admin/snapshots';

let fake: FakeAdmin, dir: string;
const ENV = ['CONFIG_SOURCE', 'CAMS_DATA_DIR', 'CAMERAS_FILE', 'PROXY_STATE_FILE', 'PROXY_TLS_FILE', 'PREFS_FILE', 'CAMERA_CREDENTIALS_FILE', 'ALLOWED_EMAILS'] as const;
const saved: Record<string, string | undefined> = {};
const ORIGIN = { Origin: 'http://127.0.0.1', Host: '127.0.0.1' };
const ADMIN = cookieFor('alpha@example.org', ALPHA);
const VIEWER = cookieFor('both@example.org', BETA);

beforeEach(async () => {
  for (const n of ENV) saved[n] = process.env[n];
  fake = await startFakeAdmin();
  dir = mkdtempSync(join(tmpdir(), 'cams-held-'));
  Object.assign(process.env, { CONFIG_SOURCE: 'cams-admin', CAMS_DATA_DIR: dir, PREFS_FILE: join(dir, 'prefs.json'), PROXY_STATE_FILE: join(dir, 'ps.json'), PROXY_TLS_FILE: join(dir, 'tls.json'), CAMERA_CREDENTIALS_FILE: join(dir, 'cred.json') });
  delete process.env.CAMERAS_FILE;
  delete process.env.ALLOWED_EMAILS;
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ v: 1, [`${ALPHA}/cam1`]: { user: 'cams', password: 'pw' }, [`${BETA}/cam1`]: { user: 'cams', password: 'pw' } }), { mode: 0o600 });
  // Both cameras confirmed earlier by their admins.
  const tv = (proxyUrl: string, host: string) => ({ proxyUrl, caFingerprints: [], proxyTlsServername: null, host, protocol: 'http', tlsServername: null });
  mkdirSync(join(dir, 'admin'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'admin/trust.json'), JSON.stringify({ v: 1, confirmed: { [`${ALPHA}/cam1`]: tv('http://127.0.0.1:1/alpha', '192.0.2.5'), [`${BETA}/cam1`]: tv('http://127.0.0.1:1/beta', '127.0.0.1:9') }, keptOld: {}, log: [] }), { mode: 0o600 });
  writeKeyFile(await enroll(fake.url, fake.code, 'test'), dir);
  writeCache(signSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.5' })) as unknown as Snapshot, dir);
  fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.5' }));
  await startConfig({ pullIntervalMs: 60_000, debounceMs: 20 });
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

type Held = { camsId: string; digest: string; fields: string[]; isNew: boolean };
const heldList = async (cookie = ADMIN) => (await request(createApp()).get('/api/admin/held').set('Cookie', cookie)).body.items as Held[];
const act = (what: 'confirm' | 'keep', items: { camsId: string; digest: string }[], cookie = ADMIN) =>
  request(createApp()).post(`/api/admin/held/${what}`).set('Cookie', cookie).set(ORIGIN).send({ items });

describe('held changes', () => {
  it('a changed host is held: the camera keeps the old host; the admin sees from → to; Confirm moves it and reports at once', async () => {
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.99', revision: 'r:00000000000000e5' }));
    await pullNow();
    expect(cameraHost(camKey(ALPHA, 'cam1'))).toBe('192.0.2.5');
    const list = await request(createApp()).get('/api/admin/held').set('Cookie', ADMIN);
    expect(list.body).toEqual({ items: [{ camsId: 'cam1', fields: ['host'], from: { host: '192.0.2.5' }, to: { host: '192.0.2.99' }, keptOld: false, isNew: false, digest: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
    expect((await request(createApp()).get('/api/me').set('Cookie', ADMIN)).body.held).toBe(1);
    const reports = fake.reports.length;
    const c = await act('confirm', [{ camsId: 'cam1', digest: list.body.items[0].digest }]);
    expect([c.status, c.body]).toEqual([200, { confirmed: ['cam1'] }]);
    expect(cameraHost(camKey(ALPHA, 'cam1'))).toBe('192.0.2.99');
    // one-shot: the same click again changes nothing
    expect((await act('confirm', [{ camsId: 'cam1', digest: list.body.items[0].digest }])).status).toBe(409);
    expect((await request(createApp()).get('/api/admin/held').set('Cookie', ADMIN)).body.items).toEqual([]);
    await expect.poll(() => fake.reports.length).toBeGreaterThan(reports);
  });

  it('Keep old: hidden from the banner, reported as keptOld', async () => {
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.99', revision: 'r:00000000000000e6' }));
    await pullNow();
    const k = await act('keep', (await heldList()).map((h) => ({ camsId: h.camsId, digest: h.digest })));
    expect(k.status).toBe(200);
    expect(cameraHost(camKey(ALPHA, 'cam1'))).toBe('192.0.2.5');
    expect((await request(createApp()).get('/api/admin/held').set('Cookie', ADMIN)).body.items).toEqual([expect.objectContaining({ keptOld: true })]);
    expect((await request(createApp()).get('/api/me').set('Cookie', ADMIN)).body.held).toBe(0);
    await expect.poll(() => fake.reports.at(-1)?.keptOld).toEqual([{ accountId: ALPHA, camsId: 'cam1', fields: ['host'] }]);
  });

  it('a viewer cannot read or confirm held changes (403); another account\'s held change is not listed', async () => {
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.99', revision: 'r:00000000000000e7' }));
    await pullNow();
    expect((await request(createApp()).get('/api/admin/held').set('Cookie', VIEWER)).status).toBe(403);
    expect((await act('confirm', [{ camsId: 'cam1', digest: 'a'.repeat(64) }], VIEWER)).status).toBe(403);
    // Beta's admin (both@example.org made admin in Beta) sees nothing of Alpha's
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.99', revision: 'r:00000000000000e8', users: { b: [{ email: 'both@example.org', role: 'admin', disabled: false }] } }));
    await pullNow();
    const b = await request(createApp()).get('/api/admin/held').set('Cookie', VIEWER);
    expect(b.body.items).toEqual([]);
    const alphaDigest = (await heldList(ADMIN))[0].digest;
    const c = await act('confirm', [{ camsId: 'cam1', digest: alphaDigest }], VIEWER); // Beta's admin, Alpha's digest
    expect([c.status, c.body.error]).toEqual([409, 'offer_changed']);
    expect(cameraHost(camKey(ALPHA, 'cam1'))).toBe('192.0.2.5');
  });

  it('a bad body → 400', async () => {
    for (const body of [{}, { camsIds: ['cam1'] }, { items: 'cam1' }, { items: [{ camsId: 'cam1' }] }, { items: [{ camsId: 'cam1', digest: 'x' }] }, { items: Array(300).fill({ camsId: 'cam1', digest: 'a'.repeat(64) }) }]) {
      expect((await request(createApp()).post('/api/admin/held/confirm').set('Cookie', ADMIN).set(ORIGIN).send(body)).status).toBe(400);
    }
  });

  it('Confirm carries the offer shown: if cams-admin changed it meanwhile, nothing is confirmed (409 offer_changed) and the banner reads again', async () => {
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.6', revision: 'r:00000000000000f1' }));
    await pullNow();
    const shown = (await heldList())[0];
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '203.0.113.66', revision: 'r:00000000000000f2' }));
    await pullNow();
    const r = await act('confirm', [{ camsId: 'cam1', digest: shown.digest }]);
    expect([r.status, r.body]).toEqual([409, { error: 'offer_changed', changed: ['cam1'] }]);
    expect(cameraHost(camKey(ALPHA, 'cam1'))).toBe('192.0.2.5');
  });

  it('a new camera is held (no password, no token) until an admin confirms it', async () => {
    fake.setSnapshot(twoAccountsSnapshot({ revision: 'r:00000000000000f3', alphaHost: '192.0.2.5', alphaCameras: [
      { id: 'cam_AAAAAAAAAAAAAAAAAAA1', camsId: 'cam1', name: 'Alpha cam', proxyId: 'prx_AAAAAAAAAAAAAAAAAAAA', proxyCameraId: 'cam1', host: '192.0.2.5', protocol: 'http', tlsServername: null, cameraUser: 'cams', webUiUrl: null, webUiNote: null },
      { id: 'cam_AAAAAAAAAAAAAAAAAAA2', camsId: 'cam2', name: 'New', proxyId: 'prx_AAAAAAAAAAAAAAAAAAAA', proxyCameraId: 'cam2', host: '192.0.2.7', protocol: 'http', tlsServername: null, cameraUser: 'cams', webUiUrl: null, webUiNote: null },
    ] }));
    await pullNow();
    const two = getCamera(camKey(ALPHA, 'cam2'))!;
    expect(two).toMatchObject({ credentials: 'unconfirmed', password: '' });
    expect(two.proxy).toBeUndefined();
    const h = (await heldList()).find((x) => x.camsId === 'cam2')!;
    expect(h.isNew).toBe(true);
    expect((await act('keep', [{ camsId: 'cam2', digest: h.digest }])).status).toBe(409); // a new camera has nothing old to keep
    expect((await act('confirm', [{ camsId: 'cam2', digest: h.digest }])).status).toBe(200);
    expect(getCamera(camKey(ALPHA, 'cam2'))?.credentials).toBe('missing'); // confirmed; its password isn't here yet
  });
});
