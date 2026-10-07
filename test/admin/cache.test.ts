// The config cache (migration P4, M §9.4): the last applied snapshot,
// verbatim with its signature, mode 600; verified at every start.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import vectors from '../../contract/cams-v1/vectors.json';
import { readCache, writeCache } from '../../server/admin/cache';
import type { AdminKeyFile } from '../../server/admin/keyfile';
import type { Snapshot } from '../../server/admin/snapshot';
import { signSnapshot } from './fakeAdmin';
import { INSTANCE, twoAccountsSnapshot } from './snapshots';

const KF = { instanceId: INSTANCE, serverKeys: [vectors.keys.server.publicKey] } as AdminKeyFile;

describe('the config cache', () => {
  it('writes verbatim (with sig), 600, and reads back verified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-cache-'));
    const s = signSnapshot(twoAccountsSnapshot()) as unknown as Snapshot;
    writeCache(s, dir);
    expect(statSync(join(dir, 'admin/config-cache.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'admin/config-cache.json'), 'utf8'))).toEqual(s);
    expect(readCache(KF, dir)).toEqual(s);
  });

  it('a tampered, foreign or missing cache is null (config_cache_untrusted), not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-cache-'));
    expect(readCache(KF, dir)).toBeNull();
    writeCache(signSnapshot(twoAccountsSnapshot()) as unknown as Snapshot, dir);
    const f = join(dir, 'admin/config-cache.json');
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...raw, generatedAt: 1 }), { mode: 0o600 });
    expect(readCache(KF, dir)).toBeNull();
    writeFileSync(f, JSON.stringify(signSnapshot(twoAccountsSnapshot(), 'other')), { mode: 0o600 });
    expect(readCache(KF, dir)).toBeNull();
    writeFileSync(f, JSON.stringify(signSnapshot({ ...twoAccountsSnapshot(), instance: { id: 'cms_99999999999999999999', name: 'x', rotateBefore: null } })), { mode: 0o600 });
    expect(readCache(KF, dir)).toBeNull();
    writeFileSync(f, '{not json', { mode: 0o600 });
    expect(readCache(KF, dir)).toBeNull();
  });
});
