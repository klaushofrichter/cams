// MCP tokens (spec 2026-10-27-mcp-server-design §6): issued by members for
// themselves, shown once, kept as a SHA-256 hash in a private file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpTokens, McpTokenError } from '../../server/mcp/tokens';

const ACC = 'acc_ALPHAALPHAALPHAALPHA';
const OTHER = 'acc_BETABETABETABETABE';
const ME = { email: 'me@example.org', via: 'google' as const };
const YOU = { email: 'you@example.org', via: 'google' as const };
let dir: string, file: string, now: number;
const clock = () => now;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cams-mcp-'));
  file = join(dir, 'mcp', 'tokens.json');
  now = 1_800_000_000_000;
});
afterEach(() => undefined);

const store = () => McpTokens.load(file, clock);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as McpTokenError).code;
  }
  return 'none';
};

describe('McpTokens', () => {
  it('issues a cmcp_ token shown once and stores only its hash, privately', () => {
    const { token, item } = store().issue(ACC, ME, { name: 'laptop', days: 30 });
    expect(token).toMatch(/^cmcp_[A-Za-z0-9_-]{43}$/);
    expect(item).toMatchObject({ name: 'laptop', accountId: ACC, issuer: ME.email, scopes: ['read'], state: 'active', expiresAt: now + 30 * 86_400_000 });
    expect(item.id).toMatch(/^mtk_[0-9A-HJKMNP-TV-Z]{20}$/);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain('sha256:');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'mcp')).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(item)).not.toMatch(/sha256|cmcp_/);
  });

  it('defaults to 30 days and refuses bad names and days', () => {
    expect(store().issue(ACC, ME, { name: 'x' }).item.expiresAt).toBe(now + 30 * 86_400_000);
    for (const input of [{ name: 'x', days: 0 }, { name: 'x', days: 91 }, { name: 'x', days: 1.5 }, { name: '', days: 1 }, { name: 'a'.repeat(65) }, { name: 'a\nb' }]) {
      expect(code(() => store().issue(ACC, ME, input))).toBe('invalid');
    }
  });

  it('caps live tokens at 3 per person and 20 per account', () => {
    const s = store();
    for (let i = 0; i < 3; i++) s.issue(ACC, ME, { name: `t${i}` });
    expect(code(() => s.issue(ACC, ME, { name: 'four' }))).toBe('too_many_tokens');
    // another account is separate
    s.issue(OTHER, ME, { name: 'elsewhere' });
    // a revoked one doesn't count
    const mine = s.list(ACC, { issuer: ME.email });
    s.revoke(ACC, mine[0].id, ME.email);
    s.issue(ACC, ME, { name: 'again' });
    for (let i = 0; i < 17; i++) s.issue(ACC, { email: `p${i}@example.org`, via: 'google' }, { name: 'n' });
    expect(s.list(ACC).filter((t) => t.state === 'active')).toHaveLength(20);
    expect(code(() => s.issue(ACC, YOU, { name: 'one too many' }))).toBe('too_many_tokens');
    // an expired one doesn't count
    now += 31 * 86_400_000;
    expect(code(() => s.issue(ACC, YOU, { name: 'later' }))).toBe('none');
  });

  it('finds only live tokens of the right shape', () => {
    const s = store();
    const { token, item } = s.issue(ACC, ME, { name: 'a', days: 1 });
    expect(s.find(token)?.id).toBe(item.id);
    expect(s.find(token.replace('cmcp_', 'cmcx_'))).toBeNull();
    expect(s.find(token + 'x'.repeat(100))).toBeNull();
    expect(s.find('cmcp_' + 'A'.repeat(43))).toBeNull();
    now += 86_400_000;
    expect(s.find(token)).toBeNull();
    const two = s.issue(ACC, ME, { name: 'b' });
    s.revoke(ACC, two.item.id, ME.email);
    expect(s.find(two.token)).toBeNull();
  });

  it('lets a member revoke only their own unless no owner is given', () => {
    const s = store();
    const { item } = s.issue(ACC, ME, { name: 'a' });
    expect(s.revoke(ACC, item.id, YOU.email, YOU.email)).toBeNull();
    expect(s.revoke(OTHER, item.id, ME.email)).toBeNull();
    expect(s.revoke(ACC, item.id, 'admin@example.org')?.state).toBe('revoked');
    expect(s.list(ACC)[0]).toMatchObject({ revokedBy: 'admin@example.org' });
  });

  it('lists per account and per issuer, never the hash', () => {
    const s = store();
    s.issue(ACC, ME, { name: 'mine' });
    s.issue(ACC, YOU, { name: 'yours' });
    s.issue(OTHER, ME, { name: 'other account' });
    expect(s.list(ACC).map((t) => t.name).sort()).toEqual(['mine', 'yours']);
    expect(s.list(ACC, { issuer: ME.email }).map((t) => t.name)).toEqual(['mine']);
    expect(JSON.stringify(s.list(ACC))).not.toContain('sha256');
  });

  it('a second instance sees a revoke once the file changed', () => {
    const a = store();
    const { token, item } = a.issue(ACC, ME, { name: 'a' });
    const b = store();
    expect(b.find(token)).not.toBeNull();
    a.revoke(ACC, item.id, ME.email);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    now += 2000;
    expect(b.find(token)).toBeNull();
  });

  it('refuses a token file anyone else can read', async () => {
    store().issue(ACC, ME, { name: 'a' });
    const { chmodSync } = await import('fs');
    chmodSync(file, 0o644);
    expect(() => store()).toThrow(/mode 600/);
  });
});
