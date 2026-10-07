// The status report (contract cams-v1 POST /cams/v1/report): clamped to the
// contract's limits; at most one per 60 s unless urgent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminClient } from '../../server/admin/client';
import { enroll } from '../../server/admin/enroll';
import { buildReport, Reporter } from '../../server/admin/report';
import type { HeldChange } from '../../server/admin/apply';
import { camsValidator, camsErrors } from '../helpers/contract';
const ALPHA = 'acc_0123456789ABCDEFGHJK'; // a contract-shaped account id (Crockford, 20)
import { startFakeAdmin, type FakeAdmin } from './fakeAdmin';
import { twoAccountsSnapshot } from './snapshots';

const STATUS = { mode: 'cams-admin' as const, appliedRevision: 'r:00000000000000a1', cacheVerifiedAt: 1, lastPullAt: 2, lastPullOkAt: 2, staleSince: null, problems: [] };
const V = { proxyUrl: null, caFingerprints: [], proxyTlsServername: null, host: 'h', protocol: 'https' as const, tlsServername: null };
const held = (n: number, keptOld = false): HeldChange[] => Array.from({ length: n }, (_, i) => ({ accountId: ALPHA, camsId: `cam${i}`, fields: ['host'], confirmed: V, offered: { ...V, host: 'x' }, keptOld }));

describe('buildReport', () => {
  it('fits the strict report-request schema with 300 held changes (clamped to 200) and 30 problems', () => {
    const r = buildReport({ ...STATUS, mode: 'shadow', problems: Array.from({ length: 30 }, (_, i) => ({ code: `p${i}`, accountId: ALPHA, detail: 'd'.repeat(300) })) }, { held: [...held(300), ...held(250, true)], shadow: { accountId: ALPHA, items: Array.from({ length: 40 }, (_, i) => `cam${i}: ${'f'.repeat(300)}`) }, tokens: { managed: 2, pending: 0, legacy: 1 }, version: '2026.10.07.1' });
    expect(r.held).toHaveLength(200);
    expect(r.keptOld).toHaveLength(200);
    expect(r.shadow).toMatchObject({ accountId: ALPHA, differences: 40 });
    expect(r.shadow!.items).toHaveLength(20);
    expect(r.problems).toHaveLength(30);
    const ok = camsValidator('report-request', 'strict')(r);
    expect([ok, camsErrors()]).toEqual([true, 'null']);
    const many = buildReport({ ...STATUS, problems: Array.from({ length: 80 }, () => ({ code: 'x'.repeat(100) })) }, { held: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 }, version: 'v' });
    expect(many.problems).toHaveLength(50);
    expect([camsValidator('report-request', 'strict')(many), camsErrors()]).toEqual([true, 'null']);
  });
});

describe('Reporter', () => {
  let fake: FakeAdmin;
  beforeEach(async () => {
    fake = await startFakeAdmin();
    fake.setSnapshot(twoAccountsSnapshot());
  });
  afterEach(() => fake.stop());

  it('sends at most once per 60 s, at once when urgent; "changed" asks for a pull', async () => {
    const client = new AdminClient(await enroll(fake.url, fake.code, 'test'));
    let t = 1_000_000;
    let pulls = 0;
    const rep = new Reporter(client, () => t, () => pulls++);
    const r = buildReport({ ...STATUS, appliedRevision: 'r:0000000000000000' }, { held: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 }, version: 'v' });
    await rep.send(r);
    await rep.send(r);
    expect(fake.reports).toHaveLength(1);
    expect(pulls).toBe(1); // the fake's revision differs: changed
    t += 30_000;
    await rep.send(r, true);
    expect(fake.reports).toHaveLength(2);
    t += 61_000;
    await rep.send(r);
    expect(fake.reports).toHaveLength(3);
  });
});
