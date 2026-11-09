// #249: Settings says when cams's admin token for a camera's proxy waits for
// the proxy to allow admin tokens (proxy info's adminWaiting), to admins only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { ALPHA, applyFleet, cookieFor, restoreMode, twoAccounts } from './helpers/fleet';

const waiting = vi.hoisted(() => ({ value: new Set<string>() }));
vi.mock('../server/configSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/configSource')>()),
  adminTokenWaiting: (accountId: string, proxyId: string) => waiting.value.has(`${accountId}/${proxyId}`),
}));

const PRX = 'prx_AAAAAAAAAAAAAAAAAAAA';
beforeEach(() => {
  const [alpha, beta] = twoAccounts();
  alpha.users = [{ email: 'admin@example.org', role: 'admin', disabled: false }, { email: 'viewer@example.org', role: 'viewer', disabled: false }];
  alpha.cameras = alpha.cameras.map((c) => ({ ...c, proxy: { ...c.proxy!, proxyId: PRX } }));
  applyFleet([alpha, beta]);
  resetProxyClients();
});
afterEach(() => {
  waiting.value.clear();
  restoreMode();
  setCameras([]);
});

const info = (email: string) => request(createApp()).get('/api/cameras/cam1/proxy/info').set('Cookie', cookieFor(email, ALPHA));

describe('proxy info: the admin token waits for the proxy (#249)', () => {
  it('tells an admin while it waits', async () => {
    waiting.value.add(`${ALPHA}/${PRX}`);
    const r = await info('admin@example.org');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reachable: false, adminWaiting: true });
  });
  it('tells a viewer nothing', async () => {
    waiting.value.add(`${ALPHA}/${PRX}`);
    expect((await info('viewer@example.org')).body.adminWaiting).toBeUndefined();
  });
  it('says nothing when it does not wait', async () => {
    expect((await info('admin@example.org')).body.adminWaiting).toBeUndefined();
  });
});
