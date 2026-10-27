// MCP tokens (spec 2026-10-27-mcp-server-design §6). A member issues one for
// themselves; it is shown once and only its SHA-256 hash is kept, in
// <data>/mcp/tokens.json (MCP_TOKENS_FILE overrides), mode 600 in a 700
// folder, written atomically. Last use and call counts live in memory. The
// file is re-read when its mtime changes (looked at most once a second), so
// an overlapping Knative revision sees a revoke at once; every write
// re-reads first. The pattern is cams-admin's BearerTokens.
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { checkPrivate, dataDir, writePrivate } from '../admin/keyfile';

export interface McpIssuer { email: string; via: 'google' | 'token'; tf?: string }
export type McpScope = 'read';
export interface StoredToken {
  id: string;
  accountId: string;
  name: string;
  hash: string;
  scopes: McpScope[];
  issuer: McpIssuer;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
}
export interface McpTokenView {
  id: string;
  name: string;
  accountId: string;
  issuer: string;
  scopes: McpScope[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
  callsToday: number;
  state: 'active' | 'expired' | 'revoked';
}

export class McpTokenError extends Error {
  constructor(public status: 400 | 404 | 409, public code: 'invalid' | 'not_found' | 'too_many_tokens', public field?: string) {
    super(code);
  }
}

const DAY = 86_400_000;
export const PREFIX = 'cmcp_';
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
export const MAX_PER_PERSON = 3;
export const MAX_PER_ACCOUNT = 20;
const PRUNE_AFTER = 30 * DAY;
// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TOKEN_ID = /^mtk_[0-9A-HJKMNP-TV-Z]{20}$/;

export const hashOf = (token: string): string => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
const newId = () => `mtk_${[...randomBytes(20)].map((b) => CROCKFORD[b & 31]).join('')}`;

export const tokensFile = (): string => process.env.MCP_TOKENS_FILE || join(dataDir(), 'mcp', 'tokens.json');

export class McpTokens {
  private list_: StoredToken[] = [];
  private mtime = -1;
  private checkedAt = -Infinity;
  private lastUsed = new Map<string, number>();
  private calls = new Map<string, { day: number; n: number }>();

  private constructor(private readonly file: string, private readonly clock: () => number) {}

  static load(file: string = tokensFile(), clock: () => number = Date.now): McpTokens {
    const t = new McpTokens(file, clock);
    t.reload();
    return t;
  }

  private reload(): void {
    let st;
    try {
      st = statSync(this.file);
    } catch {
      this.list_ = [];
      this.mtime = -1;
      return;
    }
    checkPrivate(this.file, 'EPERM_MCP_TOKENS');
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as { v?: unknown; tokens?: unknown };
      if (d.v !== 1 || !Array.isArray(d.tokens)) throw new Error('shape');
      this.list_ = (d.tokens as StoredToken[]).filter((t) => typeof t?.id === 'string' && typeof t.hash === 'string' && typeof t.accountId === 'string' && typeof t.issuer?.email === 'string');
    } catch {
      throw new Error('mcp/tokens.json is corrupt: restore it from a backup or delete it');
    }
    this.mtime = st.mtimeMs;
  }

  // At most once a second: the file changed under us (another revision).
  private fresh(): void {
    const now = this.clock();
    if (now - this.checkedAt < 1000) return;
    this.checkedAt = now;
    let m = -1;
    try {
      m = statSync(this.file).mtimeMs;
    } catch {
      /* no file yet */
    }
    if (m !== this.mtime) this.reload();
  }

  private write(): void {
    const now = this.clock();
    this.list_ = this.list_.filter((t) => now - (t.revokedAt ?? t.expiresAt) < PRUNE_AFTER);
    writePrivate(this.file, JSON.stringify({ v: 1, tokens: this.list_ }, null, 2));
    this.mtime = statSync(this.file).mtimeMs;
    this.checkedAt = now;
  }

  private live(t: StoredToken, now = this.clock()): boolean {
    return t.revokedAt === null && t.expiresAt > now;
  }

  private view(t: StoredToken): McpTokenView {
    const now = this.clock();
    const c = this.calls.get(t.id);
    return {
      id: t.id, name: t.name, accountId: t.accountId, issuer: t.issuer.email, scopes: [...t.scopes],
      createdAt: t.createdAt, expiresAt: t.expiresAt, revokedAt: t.revokedAt, revokedBy: t.revokedBy,
      lastUsedAt: this.lastUsed.get(t.id) ?? null,
      callsToday: c && c.day === Math.floor(now / DAY) ? c.n : 0,
      state: t.revokedAt !== null ? 'revoked' : t.expiresAt <= now ? 'expired' : 'active',
    };
  }

  issue(accountId: string, issuer: McpIssuer, input: unknown): { token: string; item: McpTokenView } {
    const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!NAME_RE.test(name)) throw new McpTokenError(400, 'invalid', 'name');
    const days = o.days === undefined ? DEFAULT_DAYS : o.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new McpTokenError(400, 'invalid', 'days');
    this.reload();
    const now = this.clock();
    const live = this.list_.filter((t) => t.accountId === accountId && this.live(t, now));
    const email = issuer.email.toLowerCase();
    if (live.filter((t) => t.issuer.email.toLowerCase() === email).length >= MAX_PER_PERSON || live.length >= MAX_PER_ACCOUNT) {
      throw new McpTokenError(409, 'too_many_tokens');
    }
    const token = PREFIX + randomBytes(32).toString('base64url');
    const t: StoredToken = {
      id: newId(), accountId, name, hash: hashOf(token), scopes: ['read'],
      issuer: { email: issuer.email, via: issuer.via, ...(issuer.tf ? { tf: issuer.tf } : {}) },
      createdAt: now, expiresAt: now + days * DAY, revokedAt: null, revokedBy: null,
    };
    this.list_.push(t);
    this.write();
    return { token, item: this.view(t) };
  }

  list(accountId: string, filter: { issuer?: string } = {}): McpTokenView[] {
    this.fresh();
    const want = filter.issuer?.toLowerCase();
    return this.list_
      .filter((t) => t.accountId === accountId && (want === undefined || t.issuer.email.toLowerCase() === want))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => this.view(t));
  }

  // `ownerOnly`: a member revoking; only their own token. Null when there is
  // no such token in the account (or it isn't theirs).
  revoke(accountId: string, id: string, by: string, ownerOnly?: string): McpTokenView | null {
    this.reload();
    const t = this.list_.find((x) => x.id === id && x.accountId === accountId);
    if (!t || (ownerOnly !== undefined && t.issuer.email.toLowerCase() !== ownerOnly.toLowerCase())) return null;
    if (t.revokedAt === null) {
      t.revokedAt = this.clock();
      t.revokedBy = by;
      this.write();
    }
    return this.view(t);
  }

  // The live token for a bearer value, looked up by hash; null otherwise.
  find(token: string): StoredToken | null {
    if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 128) return null;
    this.fresh();
    const want = Buffer.from(hashOf(token));
    const t = this.list_.find((x) => x.hash.length === want.length && timingSafeEqual(Buffer.from(x.hash), want));
    return t && this.live(t) ? t : null;
  }

  // The live token with this id (a signed link, an internal call); null otherwise.
  byId(id: string): StoredToken | null {
    if (typeof id !== 'string' || !TOKEN_ID.test(id)) return null;
    this.fresh();
    const t = this.list_.find((x) => x.id === id);
    return t && this.live(t) ? t : null;
  }

  // A call made with the token: last use and today's count (memory only).
  touch(id: string): void {
    const now = this.clock();
    this.lastUsed.set(id, now);
    const day = Math.floor(now / DAY);
    const c = this.calls.get(id);
    this.calls.set(id, c && c.day === day ? { day, n: c.n + 1 } : { day, n: 1 });
  }
}

let store: McpTokens | null = null;
export function getMcpTokens(): McpTokens {
  store ??= McpTokens.load();
  return store;
}
export function resetMcpTokens(): void {
  store = null;
}
