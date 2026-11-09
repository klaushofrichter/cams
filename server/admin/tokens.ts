// cams's own proxy tokens (migration P4, M §10.1, M9, R4-12): cams makes
// one client and one admin token per (account, proxy), keeps the plaintext
// only in <data>/admin/tokens.json (600, atomic), and registers only the
// hash with cams-admin, which installs it on the proxy (tokens.apply). A
// token is used once the snapshot lists it active; until then the caller
// keeps the legacy CAMERAS_FILE token. Rotation every TOKEN_ROTATE_DAYS (or
// when the instance's rotateBefore says so): the new one first, the old one
// retired (TOKEN_RETIRE_HOURS) once the new one is active, and dropped when
// the snapshot lists it revoked or no longer after its retireAt.
// Two Knative revisions may overlap: the file is re-read before every change.
import { createHash, randomBytes } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger';
import { AdminError, type AdminClient } from './client';
import { adminDir, checkPrivate, dataDir, writePrivate } from './keyfile';
import type { AccountPart, SnapProxy } from './snapshot';
import type { Problem } from './apply';

export interface LocalToken { id: string | null; accountId: string; proxyId: string; kind: 'client' | 'admin'; token: string; hash: string; createdAt: number; registeredAt: number | null; retiringAt: number | null }
type Kind = 'client' | 'admin';
const KINDS: Kind[] = ['client', 'admin'];
const DAY = 86_400_000;
// After a proxy refuses an admin token (not_allowed_on_proxy, its allow-list
// lacks tokens.apply.admin), the next tries wait 5 min, 15 min, 30 min, then
// every hour: an admin who fixes the allow-list sees it work soon (#249).
export const ADMIN_RETRY_MS = [5, 15, 30, 60].map((m) => m * 60_000);

const intEnv = (name: string, def: number, min: number, max: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= min && v <= max ? v : def;
};
const rotateDays = () => intEnv('TOKEN_ROTATE_DAYS', 90, 1, 365);
const retireHours = () => intEnv('TOKEN_RETIRE_HOURS', 24, 1, 168);

const hashOf = (token: string) => `sha256:${createHash('sha256').update(token).digest('hex')}`;
const newToken = () => randomBytes(32).toString('base64url');

export class LocalTokens {
  private list: LocalToken[] = [];
  private seen = new Map<string, string>(); // token id → last state the snapshot listed
  private refused = new Map<string, { at: number; step: number }>(); // `${account}/${proxy}` → the last admin-token refusal

  private constructor(private readonly file: string, private readonly adminRetryMs: number[]) {}

  static load(dir: string = dataDir(), opts: { adminRetryMs?: number[] } = {}): LocalTokens {
    const t = new LocalTokens(join(adminDir(dir), 'tokens.json'), opts.adminRetryMs?.length ? opts.adminRetryMs : ADMIN_RETRY_MS);
    t.list = t.read();
    return t;
  }

  private read(): LocalToken[] {
    try {
      statSync(this.file);
    } catch {
      return [];
    }
    checkPrivate(this.file, 'EPERM_TOKENS');
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as { v?: unknown; tokens?: unknown };
      if (d.v !== 1 || !Array.isArray(d.tokens)) throw new Error('shape');
      return (d.tokens as LocalToken[]).filter((t) => typeof t.token === 'string' && typeof t.hash === 'string' && typeof t.proxyId === 'string');
    } catch {
      throw new Error('admin/tokens.json is corrupt: restore it from a backup');
    }
  }

  private write(): void {
    writePrivate(this.file, JSON.stringify({ v: 1, tokens: this.list }, null, 2));
  }

  private mine(accountId: string, proxyId: string, kind: Kind): LocalToken[] {
    return this.list.filter((t) => t.accountId === accountId && t.proxyId === proxyId && t.kind === kind);
  }

  // The token to use: the newest one the snapshot lists active, else retiring.
  tokenFor(accountId: string, proxyId: string, kind: Kind, snapshotStates: Map<string, string>): string | undefined {
    for (const [id, state] of snapshotStates) this.seen.set(id, state);
    const listed = this.mine(accountId, proxyId, kind).filter((t) => t.id).sort((a, b) => b.createdAt - a.createdAt);
    return (listed.find((t) => snapshotStates.get(t.id!) === 'active') ?? listed.find((t) => snapshotStates.get(t.id!) === 'retiring'))?.token;
  }

  private retryAt(r: { at: number; step: number }): number {
    return r.at + this.adminRetryMs[Math.min(r.step, this.adminRetryMs.length - 1)];
  }

  // When the earliest refused admin token may be tried again (null: none waits).
  adminRetryAt(): number | null {
    let min: number | null = null;
    for (const r of this.refused.values()) min = Math.min(min ?? Infinity, this.retryAt(r));
    return min;
  }

  counts(): { managed: number; pending: number } {
    let managed = 0, pending = 0;
    for (const t of this.list) {
      const s = t.id ? this.seen.get(t.id) : undefined;
      if (s === 'active') managed++;
      else if (s === 'pending' || !t.id) pending++;
    }
    return { managed, pending };
  }

  // After each applied snapshot (and daily): every served proxy gets its
  // tokens, rotation and retirement move on, gone tokens are dropped.
  async ensure(parts: AccountPart[], client: AdminClient, now: number, rotateBefore: number | null = null): Promise<{ registered: number; problems: Problem[] }> {
    this.list = this.read();
    // A proxy no longer served keeps no admin-token back-off.
    const served = new Set(parts.flatMap((p) => p.proxies.map((x) => `${p.account.id}/${x.id}`)));
    for (const key of this.refused.keys()) if (!served.has(key)) this.refused.delete(key);
    let registered = 0;
    const problems: Problem[] = [];
    for (const part of parts) {
      for (const proxy of part.proxies) {
        for (const kind of KINDS) {
          const r = await this.ensureOne(part.account.id, proxy, kind, client, now, rotateBefore);
          registered += r.registered;
          problems.push(...r.problems);
        }
      }
    }
    return { registered, problems };
  }

  private async ensureOne(accountId: string, proxy: SnapProxy, kind: Kind, client: AdminClient, now: number, rotateBefore: number | null): Promise<{ registered: number; problems: Problem[] }> {
    const states = new Map(proxy.tokens.map((t) => [t.id, t.state]));
    for (const [id, state] of states) this.seen.set(id, state);
    const retireAt = new Map(proxy.tokens.map((t) => [t.id, t.retireAt]));
    const problems: Problem[] = [];
    const refusedKey = `${accountId}/${proxy.id}`;
    const refused = kind === 'admin' ? this.refused.get(refusedKey) : undefined;
    // Still waiting to try again: the problem stays listed.
    if (refused && now < this.retryAt(refused)) return { registered: 0, problems: [{ code: 'admin_token_not_allowed', accountId, detail: `proxy ${proxy.id}` }] };
    // Drop what is gone: revoked, or no longer listed after its retirement.
    const gone = (t: LocalToken) => !!t.id && (states.get(t.id) === 'revoked' || (!states.has(t.id) && t.retiringAt !== null && now > t.retiringAt));
    if (this.mine(accountId, proxy.id, kind).some(gone)) {
      this.list = this.read().filter((t) => !(t.accountId === accountId && t.proxyId === proxy.id && t.kind === kind && gone(t)));
      this.write();
    }
    const mine = this.mine(accountId, proxy.id, kind);
    const live = mine.filter((t) => t.id && (states.get(t.id) === 'pending' || states.get(t.id) === 'active')).sort((a, b) => b.createdAt - a.createdAt);
    const active = live.filter((t) => states.get(t.id!) === 'active');
    // A newer active token: the older active ones retire.
    for (const old of active.slice(1)) {
      if (old.retiringAt !== null) continue;
      try {
        const r = await client.retireToken(old.id!, retireHours());
        this.list = this.read().map((t) => (t.id === old.id ? { ...t, retiringAt: r.retireAt } : t));
        this.write();
        logger.info({ tokenId: old.id, proxyId: proxy.id, kind }, 'proxy_token_retiring');
      } catch (err) {
        if (err instanceof AdminError && err.error === 'not_active') continue;
        problems.push({ code: 'token_retire_failed', accountId, detail: `proxy ${proxy.id}` });
      }
    }
    const newest = active[0];
    const due = !!newest && (now - newest.createdAt > rotateDays() * DAY || (rotateBefore !== null && newest.createdAt < rotateBefore));
    const pending = live.find((t) => states.get(t.id!) === 'pending');
    if (kind === 'admin' && live.length) this.refused.delete(refusedKey); // a live admin token: no longer refused
    if (live.length && !(due && !pending)) {
      // A leftover never registered (another revision won): dropped.
      if (mine.some((t) => !t.id)) {
        this.list = this.read().filter((t) => !(t.accountId === accountId && t.proxyId === proxy.id && t.kind === kind && !t.id));
        this.write();
      }
      void retireAt;
      return { registered: 0, problems };
    }
    // A token to register: one saved earlier but never registered, else a new one (saved FIRST).
    let tok = mine.find((t) => !t.id);
    if (!tok) {
      const token = newToken();
      tok = { id: null, accountId, proxyId: proxy.id, kind, token, hash: hashOf(token), createdAt: now, registeredAt: null, retiringAt: null };
      this.list = [...this.read(), tok];
      this.write();
    }
    try {
      const r = await client.registerToken(proxy.id, kind, tok.hash);
      this.list = this.read().map((t) => (t.hash === tok!.hash ? { ...t, id: r.tokenId, registeredAt: now } : t));
      this.write();
      this.seen.set(r.tokenId, r.state);
      if (kind === 'admin') this.refused.delete(refusedKey);
      logger.info({ tokenId: r.tokenId, proxyId: proxy.id, kind }, 'proxy_token_registered');
      return { registered: 1, problems };
    } catch (err) {
      const e = err instanceof AdminError ? err : null;
      if (e?.error === 'pending_exists') {
        // Another revision's token is pending: use that one (it is in the shared file).
        const theirs = typeof e.detail?.tokenId === 'string' ? e.detail.tokenId : null;
        const fresh = this.read();
        if (theirs && fresh.some((t) => t.id === theirs)) {
          this.list = fresh.filter((t) => t.hash !== tok!.hash);
          this.write();
        } else this.list = fresh;
        return { registered: 0, problems };
      }
      if (e?.error === 'not_allowed_on_proxy' && kind === 'admin') {
        this.refused.set(refusedKey, { at: now, step: refused ? refused.step + 1 : 0 });
        this.list = this.read().filter((t) => t.hash !== tok!.hash);
        this.write();
        return { registered: 0, problems: [{ code: 'admin_token_not_allowed', accountId, detail: `proxy ${proxy.id}` }] };
      }
      problems.push({ code: e?.error ? `token_${e.error}`.slice(0, 64) : 'token_register_failed', accountId, detail: `proxy ${proxy.id}` });
      return { registered: 0, problems };
    }
  }
}
