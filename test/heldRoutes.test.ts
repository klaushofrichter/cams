// The held-change routes (migration P4, M §9.7): account admins see what
// cams-admin changed (from → to) and confirm or keep the old values;
// viewers can't, and no account sees another's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { writeCache } from '../server/admin/cache';
import { enroll } from '../server/admin/enroll';
import { writeKeyFile } from '../server/admin/keyfile';
import type { Snapshot } from '../server/admin/snapshot';
import { createApp } from '../server/app';
import { cameraHost, setCameras } from '../server/cameraRegistry';
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
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ v: 1, 'alpha/cam1': { user: 'cams', password: 'pw' }, 'beta/cam1': { user: 'cams', password: 'pw' } }), { mode: 0o600 });
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

describe('held changes', () => {
  it('a changed host is held: the camera keeps the old host; the admin sees from → to; Confirm moves it and reports at once', async () => {
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.99', revision: 'r:00000000000000e5' }));
    await pullNow();
    expect(cameraHost(camKey(ALPHA, 'cam1'))).toBe('192.0.2.5');
    const list = await request(createApp()).get('/api/admin/held').set('Cookie', ADMIN);
    expect(list.body).toEqual({ items: [{ camsId: 'cam1', fields: ['host'], from: { host: '192.0.2.5' }, to: { host: '192.0.2.99' }, keptOld: false }] });
    expect((await request(createApp()).get('/api/me').set('Cookie', ADMIN)).body.held).toBe(1);
    const reports = fake.reports.length;
    const c = await request(createApp()).post('/api/admin/held/confirm').set('Cookie', ADMIN).set(ORIGIN).send({ camsIds: ['cam1'] });
    expect(c.status).toBe(200);
    expect(cameraHost(camKey(ALPHA, 'cam1'))).toBe('192.0.2.99');
    expect((await request(createApp()).get('/api/admin/held').set('Cookie', ADMIN)).body.items).toEqual([]);
    await expect.poll(() => fake.reports.length).toBeGreaterThan(reports);
  });

  it('Keep old: hidden from the banner, reported as keptOld', async () => {
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.99', revision: 'r:00000000000000e6' }));
    await pullNow();
    const k = await request(createApp()).post('/api/admin/held/keep').set('Cookie', ADMIN).set(ORIGIN).send({ camsIds: ['cam1'] });
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
    expect((await request(createApp()).post('/api/admin/held/confirm').set('Cookie', VIEWER).set(ORIGIN).send({ camsIds: ['cam1'] })).status).toBe(403);
    // Beta's admin (both@example.org made admin in Beta) sees nothing of Alpha's
    fake.setSnapshot(twoAccountsSnapshot({ alphaHost: '192.0.2.99', revision: 'r:00000000000000e8', users: { b: [{ email: 'both@example.org', role: 'admin', disabled: false }] } }));
    await pullNow();
    const b = await request(createApp()).get('/api/admin/held').set('Cookie', VIEWER);
    expect(b.body.items).toEqual([]);
    const c = await request(createApp()).post('/api/admin/held/confirm').set('Cookie', VIEWER).set(ORIGIN).send({ camsIds: ['cam1'] });
    expect(c.body).toEqual({ confirmed: [] });
    expect(cameraHost(camKey(ALPHA, 'cam1'))).toBe('192.0.2.5');
  });

  it('a bad body → 400', async () => {
    for (const body of [{}, { camsIds: 'cam1' }, { camsIds: [7] }, { camsIds: Array(300).fill('cam1') }]) {
      expect((await request(createApp()).post('/api/admin/held/confirm').set('Cookie', ADMIN).set(ORIGIN).send(body)).status).toBe(400);
    }
  });
});
