// Viewer tokens, the cams side (cams-admin design
// docs/superpowers/specs/2026-11-05-viewer-tokens-design.md §9): a token
// (`cav_` + 22 base62) made in cams-admin signs a person in as a viewer of
// its accounts until it expires. The snapshot (contract cams-v1, format 4)
// lists per account the tokens valid at its time, by fingerprint only; cams
// joins them across accounts by id and checks them on every request:
// listed, fingerprint the same, not expired by cams-admin's clock, and a good
// pull in the last 24 h (Klaus's answer 2). cams-admin mode only. The token
// itself is never stored, logged or compared other than through its
// fingerprint (a map lookup on the hash: no timing leak of the token).
import { createHash } from 'crypto';
import { fleetAccounts, type AccountRef, type FleetAccount } from './fleet';

export const VIEWER_TOKEN_RE = /^cav_[0-9A-Za-z]{22}$/;
export const VIEWER_TOKEN_ID_RE = /^vtk_[0-9A-HJKMNP-TV-Z]{20}$/;
export const VIEWER_TOKEN_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
export const SESSION_TAG_RE = /^[0-9a-f]{16}$/;
// Klaus's answer 2: a viewer that has lost cams-admin for this long stops
// taking its tokens (new sign-ins and existing sessions).
export const OFFLINE_LIMIT_MS = 24 * 3_600_000;
// The report's viewerTokens (contract: ≤ 200).
export const MAX_REPORTED_USES = 200;

// One account's entry in the snapshot.
export interface ViewerTokenGrant { id: string; name: string; fingerprint: string; expiresAt: number }
// A token as cams knows it: joined across the accounts listing it.
export interface ViewerToken extends ViewerTokenGrant { accounts: AccountRef[] }

// "sha256:" + hex(SHA-256(UTF-8("cams-viewer-token v1\n" + token))), the
// contract's rule (vectors.json viewerTokens).
export function viewerTokenFingerprint(token: string): string {
  return 'sha256:' + createHash('sha256').update(`cams-viewer-token v1\n${token}`, 'utf8').digest('hex');
}

// The sign-in link, with the token in the fragment only.
export const viewerTokenLink = (origin: string, token: string): string => `${origin}/token#t=${token}`;

// What a session cookie keeps of the fingerprint: 64 bits, like the Pi
// token's session fingerprint. Never the token.
export const sessionTag = (fingerprint: string): string => fingerprint.slice(7, 23);

// The person's identity inside cams (preferences, per-user limits, the
// archive's "on behalf of"): never an email, so never a member's.
export const viewerTokenUser = (id: string): string => `viewer-token:${id}`;

// --- the clock and the configuration's freshness -----------------------------
// configSource registers the real one (its pull times and cams-admin's
// measured clock offset); tests set their own.
export interface ViewerTokenClock {
  now(): number; // the local clock (the pull times are on it)
  adminNow(): number; // cams-admin's clock: the local one plus the measured offset
  lastGoodAt(): number | null; // the last good pull (or the cache's write time after a start)
  enabled(): boolean; // cams-admin mode
}
const OFF: ViewerTokenClock = { now: Date.now, adminNow: Date.now, lastGoodAt: () => null, enabled: () => false };
let registered: ViewerTokenClock = OFF;
let override: ViewerTokenClock | null = null;
const clock = (): ViewerTokenClock => override ?? registered;
export function registerViewerTokenClock(c: ViewerTokenClock): void {
  registered = c;
}
// Tests: their own clock, or null for the registered one again.
export function setViewerTokenClock(c: ViewerTokenClock | null): void {
  override = c;
}
export const viewerTokenNow = (): number => clock().adminNow();

function fresh(c: ViewerTokenClock): boolean {
  const last = c.lastGoodAt();
  return last !== null && c.now() - last <= OFFLINE_LIMIT_MS;
}

// --- the index, rebuilt when the fleet changes ------------------------------
interface Index { byId: Map<string, ViewerToken>; byFingerprint: Map<string, ViewerToken> }
let indexed: readonly FleetAccount[] | null = null;
let index: Index = { byId: new Map(), byFingerprint: new Map() };

// Joined by id: every account listing it, the earliest expiry. An id listed
// with two fingerprints, or a fingerprint under two ids, can't be told
// apart safely: such a token is left out.
export function indexViewerTokens(accounts: readonly FleetAccount[]): Index {
  const byId = new Map<string, ViewerToken>();
  const bad = new Set<string>();
  for (const a of accounts) {
    for (const g of a.viewerTokens ?? []) {
      const ref = { id: a.id, name: a.name, displayName: a.displayName };
      const t = byId.get(g.id);
      if (!t) byId.set(g.id, { id: g.id, name: g.name, fingerprint: g.fingerprint, expiresAt: g.expiresAt, accounts: [ref] });
      else if (t.fingerprint !== g.fingerprint) bad.add(g.id);
      else if (!t.accounts.some((x) => x.id === a.id)) {
        t.accounts.push(ref);
        t.expiresAt = Math.min(t.expiresAt, g.expiresAt);
      }
    }
  }
  for (const id of bad) byId.delete(id);
  const byFingerprint = new Map<string, ViewerToken>();
  const twice = new Set<string>();
  for (const t of byId.values()) {
    if (byFingerprint.has(t.fingerprint)) twice.add(t.fingerprint);
    byFingerprint.set(t.fingerprint, t);
  }
  for (const t of [...byId.values()]) if (twice.has(t.fingerprint)) byId.delete(t.id);
  for (const fp of twice) byFingerprint.delete(fp);
  for (const t of byId.values()) t.accounts.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return { byId, byFingerprint };
}

// setFleet makes a new account list each time: rebuilt on the next read.
export function viewerTokens(): Index {
  const accounts = fleetAccounts();
  if (accounts !== indexed) {
    index = indexViewerTokens(accounts);
    indexed = accounts;
  }
  return index;
}

export type ViewerTokenRefusal = 'off' | 'format' | 'offline' | 'unknown' | 'expired';

// A token presented at sign-in. The reason is for the log and tests; the
// client always gets the one `invalid_token`.
export function checkViewerToken(token: unknown): { ok: true; token: ViewerToken } | { ok: false; reason: ViewerTokenRefusal } {
  const c = clock();
  if (!c.enabled()) return { ok: false, reason: 'off' };
  if (typeof token !== 'string' || !VIEWER_TOKEN_RE.test(token)) return { ok: false, reason: 'format' };
  if (!fresh(c)) return { ok: false, reason: 'offline' };
  const t = viewerTokens().byFingerprint.get(viewerTokenFingerprint(token));
  if (!t) return { ok: false, reason: 'unknown' };
  if (t.expiresAt <= c.adminNow()) return { ok: false, reason: 'expired' };
  return { ok: true, token: t };
}

// A session's token, on every request: still listed under the same
// fingerprint, not expired, cams-admin reached in the last 24 h.
export function viewerTokenForSession(id: string, tag: string): ViewerToken | null {
  const c = clock();
  if (!c.enabled() || !fresh(c)) return null;
  const t = viewerTokens().byId.get(id);
  if (!t || sessionTag(t.fingerprint) !== tag || t.expiresAt <= c.adminNow()) return null;
  return t;
}

// --- last used (design §9.6) -------------------------------------------------
// Per token id the newest use since the last report, rounded down to the
// minute, in memory. A restart loses at most one report's worth.
const uses = new Map<string, number>();

// True for the first use since the last report (the caller asks for one).
export function noteViewerTokenUse(id: string): boolean {
  const at = Math.floor(clock().adminNow() / 60_000) * 60_000;
  const before = uses.get(id);
  if (before === undefined || at > before) uses.set(id, at);
  return before === undefined;
}

// The report's list: the newest first, at most 200; the rest stay for the next.
export function takeViewerTokenUses(): { id: string; lastUsedAt: number }[] {
  const list = [...uses].map(([id, lastUsedAt]) => ({ id, lastUsedAt })).sort((a, b) => b.lastUsedAt - a.lastUsedAt || (a.id < b.id ? -1 : 1)).slice(0, MAX_REPORTED_USES);
  for (const u of list) uses.delete(u.id);
  return list;
}

// A report that wasn't sent: its list back, unless a newer use came since.
export function returnViewerTokenUses(list: { id: string; lastUsedAt: number }[]): void {
  for (const u of list) if (!((uses.get(u.id) ?? -1) >= u.lastUsedAt)) uses.set(u.id, u.lastUsedAt);
}
