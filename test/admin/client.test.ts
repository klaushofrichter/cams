// The signed client (contract cams-v1): every request signed, every answer's
// signature verified against the pinned server keys before its status is
// looked at; one retry on a signed clock_skew; 1 MiB answers at most.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AdminClient, AdminError } from '../../server/admin/client';
import { enroll } from '../../server/admin/enroll';
import type { AdminKeyFile } from '../../server/admin/keyfile';
import vectors from '../../contract/cams-v1/vectors.json';
import { startFakeAdmin, type FakeAdmin } from './fakeAdmin';

let fake: FakeAdmin, kf: AdminKeyFile;
const SNAP = () => JSON.parse(JSON.stringify(vectors.snapshots[0].snapshot)) as Record<string, unknown>;
beforeEach(async () => {
  fake = await startFakeAdmin();
  kf = await enroll(fake.url, fake.code, 'test');
  fake.setSnapshot(SNAP());
});
afterEach(() => fake.stop());

describe('the signed client', () => {
  it('signed GET config: 200 then 304 with If-None-Match; the request verifies on the fake with the enrolled key', async () => {
    const c = new AdminClient(kf);
    const a = await c.getConfig(null);
    expect(a.status).toBe(200);
    if (a.status !== 200) throw new Error('x');
    expect(a.etag).toBe('r:0123456789abcdef');
    expect((a.body as { sig: string }).sig).toBe(vectors.snapshots[0].sig);
    expect(fake.keyState).toBe('active');
    expect((await c.getConfig(a.etag)).status).toBe(304);
    expect(fake.requests.at(-1)!.headers['if-none-match']).toBe('"r:0123456789abcdef"');
    const h = fake.requests.at(-1)!.headers;
    expect(h['x-cams-nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(h['x-cams-instance']).toBe(kf.instanceId);
  });

  it('posts tokens, retire and report as the contract says', async () => {
    const c = new AdminClient(kf);
    const t = await c.registerToken('prx_00000000000000000001', 'client', `sha256:${'a'.repeat(64)}`);
    expect(t).toMatchObject({ status: 201, state: 'pending', label: 'cams cluster' });
    fake.tokens[0].state = 'active';
    expect(await c.retireToken(t.tokenId, 2)).toMatchObject({ tokenId: t.tokenId, state: 'retiring' });
    const r = await c.report({ v: 1, mode: 'cams-admin', version: 'test', appliedRevision: 'r:0123456789abcdef', cacheVerifiedAt: null, lastPullAt: null, held: [], keptOld: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 }, problems: [] });
    expect(r).toEqual({ changed: false, revision: 'r:0123456789abcdef' });
    fake.tokenAnswer = { status: 409, body: { error: 'pending_exists', tokenId: 'tok_X' } };
    await expect(c.registerToken('prx_00000000000000000001', 'client', `sha256:${'b'.repeat(64)}`)).rejects.toMatchObject({ code: 'refused', status: 409, error: 'pending_exists' });
  });

  it('an unsigned answer, or one signed by another key, is AdminError unsigned, whatever its status', async () => {
    const c = new AdminClient(kf);
    fake.unsigned = true;
    await expect(c.getConfig(null)).rejects.toMatchObject({ code: 'unsigned' });
    fake.unsigned = false;
    fake.wrongKey = true;
    await expect(c.getConfig(null)).rejects.toMatchObject({ code: 'unsigned' });
    await expect(c.report({ v: 1 } as never)).rejects.toBeInstanceOf(AdminError);
  });

  it('clock skew: one signed 401 clock_skew → offset set, the retry passes; an unsigned clock_skew changes nothing', async () => {
    fake.skewBy(3 * 3_600_000);
    const c = new AdminClient(kf);
    expect((await c.getConfig(null)).status).toBe(200);
    expect(Math.abs(c.offsetMs() - 3 * 3_600_000)).toBeLessThan(5000);
    const n = fake.requests.length;
    expect((await c.getConfig(null)).status).toBe(200); // the offset is kept: no second skew
    expect(fake.requests.length).toBe(n + 1);
    // unsigned skew answer: refused, offset unchanged
    const c2 = new AdminClient(kf);
    fake.unsigned = true;
    await expect(c2.getConfig(null)).rejects.toMatchObject({ code: 'unsigned' });
    expect(c2.offsetMs()).toBe(0);
  });

  it('a skew beyond 7 days is not taken', async () => {
    fake.skewBy(8 * 86_400_000);
    const c = new AdminClient(kf);
    await expect(c.getConfig(null)).rejects.toMatchObject({ code: 'refused', error: 'clock_skew' });
    expect(c.offsetMs()).toBe(0);
  });

  it('an answer over 1 MiB → too_large without buffering it all', async () => {
    fake.oversize = true;
    await expect(new AdminClient(kf).getConfig(null)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('cams-admin down → unreachable within the timeout', async () => {
    fake.down();
    const t0 = Date.now();
    await expect(new AdminClient(kf, { timeoutMs: 500 }).getConfig(null)).rejects.toMatchObject({ code: 'unreachable' });
    fake.up();
    fake.slowMs = 2000;
    await expect(new AdminClient(kf, { timeoutMs: 300 }).getConfig(null)).rejects.toMatchObject({ code: 'unreachable' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('CAMS_ADMIN_URL overrides the enrolled URL', async () => {
    const saved = process.env.CAMS_ADMIN_URL;
    process.env.CAMS_ADMIN_URL = fake.url;
    try {
      expect((await new AdminClient({ ...kf, url: 'http://127.0.0.1:1' }).getConfig(null)).status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.CAMS_ADMIN_URL;
      else process.env.CAMS_ADMIN_URL = saved;
    }
    void mkdtempSync; void tmpdir; void join;
  });
});
