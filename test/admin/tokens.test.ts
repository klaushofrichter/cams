// cams's own proxy tokens (migration P4, M §10.1, M9, R4-12): made here,
// kept here (<data>/admin/tokens.json, 600), registered with cams-admin as
// hashes only; the legacy file token until the new one is active; rotation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AdminClient } from '../../server/admin/client';
import { enroll } from '../../server/admin/enroll';
import type { AdminKeyFile } from '../../server/admin/keyfile';
import { accountParts, verifySnapshot, type AccountPart } from '../../server/admin/snapshot';
import { LocalTokens, type LocalToken } from '../../server/admin/tokens';
import vectors from '../../contract/cams-v1/vectors.json';
import { ALPHA, BETA } from '../helpers/fleet';
import { signSnapshot, startFakeAdmin, type FakeAdmin } from './fakeAdmin';
import { INSTANCE, PRX_A, PRX_B, twoAccountsSnapshot } from './snapshots';

let fake: FakeAdmin, kf: AdminKeyFile, client: AdminClient, dir: string;
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const partsOf = (o: Parameters<typeof twoAccountsSnapshot>[0] = {}, extra: Record<string, unknown> = {}): { parts: AccountPart[]; rotateBefore: number | null } => {
  const v = verifySnapshot(signSnapshot({ ...twoAccountsSnapshot(o), ...extra }), [vectors.keys.server.publicKey], INSTANCE);
  if (!v.ok) throw new Error(v.reason);
  return { parts: accountParts(v.snapshot).ok, rotateBefore: v.snapshot.instance.rotateBefore };
};
// The snapshot's view of the fake's token rows (ids, kinds, states).
const snapTokens = (proxyId: string) => fake.tokens.filter((t) => t.proxyId === proxyId).map((t) => ({ id: t.tokenId, kind: t.kind, state: t.state, retireAt: t.retireAt }));
const current = (o: Parameters<typeof twoAccountsSnapshot>[0] = {}) => partsOf({ ...o, tokens: { a: snapTokens(PRX_A), b: snapTokens(PRX_B) } });
const readLocal = (): LocalToken[] => JSON.parse(readFileSync(join(dir, 'admin/tokens.json'), 'utf8')).tokens;
const statesOf = (p: AccountPart, proxyId: string) => new Map(p.proxies.find((x) => x.id === proxyId)!.tokens.map((t) => [t.id, t.state]));

beforeEach(async () => {
  fake = await startFakeAdmin();
  kf = await enroll(fake.url, fake.code, 'test');
  client = new AdminClient(kf);
  dir = mkdtempSync(join(tmpdir(), 'cams-tok-'));
});
afterEach(() => fake.stop());

describe('LocalTokens', () => {
  it('registers a client and an admin token per proxy; the plaintext never leaves the file; only the hash is sent', async () => {
    const tokens = LocalTokens.load(dir);
    const r = await tokens.ensure(current().parts, client, NOW);
    expect(r.registered).toBe(4);
    expect(fake.registered.map((x) => [x.proxyId, x.kind]).sort()).toEqual([[PRX_A, 'admin'], [PRX_A, 'client'], [PRX_B, 'admin'], [PRX_B, 'client']]);
    expect(fake.registered.every((x) => /^sha256:[0-9a-f]{64}$/.test(x.hash))).toBe(true);
    const local = readLocal();
    for (const t of local) {
      expect(t.hash).toBe(`sha256:${createHash('sha256').update(t.token).digest('hex')}`);
      expect(JSON.stringify(fake.requests)).not.toContain(t.token);
      expect(t.id).toMatch(/^tok_/);
    }
    // nothing new while they are pending
    expect((await tokens.ensure(current().parts, client, NOW)).registered).toBe(0);
    expect(tokens.counts()).toEqual({ managed: 0, pending: 4 });
  });

  it('uses the legacy file token until the snapshot lists the new one active, then switches', async () => {
    const tokens = LocalTokens.load(dir);
    await tokens.ensure(current().parts, client, NOW);
    const a = current().parts.find((p) => p.account.id === ALPHA)!;
    expect(tokens.tokenFor(ALPHA, PRX_A, 'client', statesOf(a, PRX_A))).toBeUndefined(); // pending: the caller keeps the legacy token
    for (const t of fake.tokens) if (t.proxyId === PRX_A) t.state = 'active';
    const a2 = current().parts.find((p) => p.account.id === ALPHA)!;
    const mine = readLocal().find((t) => t.proxyId === PRX_A && t.kind === 'client')!;
    expect(tokens.tokenFor(ALPHA, PRX_A, 'client', statesOf(a2, PRX_A))).toBe(mine.token);
    expect(tokens.tokenFor(BETA, PRX_B, 'client', statesOf(current().parts.find((p) => p.account.id === BETA)!, PRX_B))).toBeUndefined();
    expect(tokens.counts()).toEqual({ managed: 2, pending: 2 });
  });

  it('pending_exists → adopts the other revision\'s token from the shared file (no second token)', async () => {
    // Two revisions of the instance share the file and race: one wins, the
    // other gets pending_exists, adopts the winner's token and drops its own.
    const alpha = partsOf().parts.filter((p) => p.account.id === ALPHA);
    const one = LocalTokens.load(dir), two = LocalTokens.load(dir);
    await Promise.all([one.ensure(alpha, client, NOW), two.ensure(alpha, client, NOW)]);
    await LocalTokens.load(dir).ensure(current().parts.filter((p) => p.account.id === ALPHA), client, NOW);
    const clients = readLocal().filter((t) => t.kind === 'client' && t.proxyId === PRX_A);
    expect(clients).toHaveLength(1);
    expect(fake.tokens.filter((t) => t.kind === 'client' && t.proxyId === PRX_A).map((t) => t.tokenId)).toEqual([clients[0].id]);
  });

  it('rotation after 90 days or rotateBefore: new token, switch when active, retire the old (24 h), drop it when revoked', async () => {
    const tokens = LocalTokens.load(dir);
    await tokens.ensure(current().parts.filter((p) => p.account.id === ALPHA), client, NOW);
    for (const t of fake.tokens) t.state = 'active';
    const first = readLocal().find((t) => t.kind === 'client')!;
    // 91 days later: a new one
    await tokens.ensure(current().parts.filter((p) => p.account.id === ALPHA), client, NOW + 91 * DAY);
    const clients = () => readLocal().filter((t) => t.kind === 'client' && t.proxyId === PRX_A);
    expect(clients()).toHaveLength(2);
    const second = clients().find((t) => t.id !== first.id)!;
    // still the old one in use while the new one is pending
    let a = current().parts.find((p) => p.account.id === ALPHA)!;
    expect(tokens.tokenFor(ALPHA, PRX_A, 'client', statesOf(a, PRX_A))).toBe(first.token);
    fake.tokens.find((t) => t.tokenId === second.id)!.state = 'active';
    await tokens.ensure(current().parts.filter((p) => p.account.id === ALPHA), client, NOW + 91 * DAY);
    a = current().parts.find((p) => p.account.id === ALPHA)!;
    expect(tokens.tokenFor(ALPHA, PRX_A, 'client', statesOf(a, PRX_A))).toBe(second.token);
    const old = fake.tokens.find((t) => t.tokenId === first.id)!;
    expect(old.state).toBe('retiring');
    expect(old.retireAt! - Date.now()).toBeGreaterThan(23 * 3_600_000);
    old.state = 'revoked';
    await tokens.ensure(current().parts.filter((p) => p.account.id === ALPHA), client, NOW + 92 * DAY);
    expect(clients().map((t) => t.id)).toEqual([second.id]);
    // rotateBefore later than the token's creation: rotate now
    const { parts } = partsOf({ tokens: { a: snapTokens(PRX_A), b: [] } }, { instance: { id: INSTANCE, name: 'cluster', rotateBefore: NOW + 100 * DAY } });
    await tokens.ensure(parts.filter((p) => p.account.id === ALPHA), client, NOW + 92 * DAY, NOW + 100 * DAY);
    expect(clients()).toHaveLength(2);
  });

  it('tokens.json is 600 and written before the registration (a crash in between re-registers the same hash, idempotent)', async () => {
    fake.down();
    const tokens = LocalTokens.load(dir);
    const r = await tokens.ensure(current().parts.filter((p) => p.account.id === ALPHA), client, NOW);
    expect(r.registered).toBe(0);
    expect(statSync(join(dir, 'admin/tokens.json')).mode & 0o777).toBe(0o600);
    const saved = readLocal();
    expect(saved.map((t) => t.id)).toEqual([null, null]);
    fake.up();
    await LocalTokens.load(dir).ensure(current().parts.filter((p) => p.account.id === ALPHA), client, NOW);
    expect(readLocal().map((t) => t.hash).sort()).toEqual(saved.map((t) => t.hash).sort());
    expect(readLocal().every((t) => t.id)).toBe(true);
  });

  it('an admin token the proxy refuses: legacy admin token kept, one problem a day', async () => {
    const tokens = LocalTokens.load(dir);
    const realAnswer = fake.tokenAnswer;
    void realAnswer;
    // client registers, admin is refused
    const parts = current().parts.filter((p) => p.account.id === ALPHA);
    const orig = client.registerToken.bind(client);
    let calls = 0;
    (client as unknown as { registerToken: typeof orig }).registerToken = async (proxyId, kind, hash) => {
      calls++;
      if (kind === 'admin') {
        fake.tokenAnswer = { status: 409, body: { error: 'not_allowed_on_proxy' } };
      }
      return orig(proxyId, kind, hash);
    };
    const r1 = await tokens.ensure(parts, client, NOW);
    expect(r1.problems.map((p) => p.code)).toEqual(['admin_token_not_allowed']);
    const r2 = await tokens.ensure(parts, client, NOW + 3_600_000);
    expect(r2.problems).toEqual([]);
    expect(readLocal().filter((t) => t.kind === 'admin')).toEqual([]);
    expect(calls).toBeGreaterThan(0);
    const a = current().parts.find((p) => p.account.id === ALPHA)!;
    expect(tokens.tokenFor(ALPHA, PRX_A, 'admin', statesOf(a, PRX_A))).toBeUndefined();
    void writeFileSync;
  });
});
