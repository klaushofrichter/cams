import { NextFunction, Request, Response } from 'express';
import { expiredSessionKind, SESSION_COOKIE, verifySession } from '../session';
import { configMode, reportSoon } from '../configSource';
import type { AccountRef, Role } from '../fleet';
import { membershipsOf, tokenAccount, type Membership } from '../membership';
import { internalPrincipal, isInternal } from '../mcp/internal';
import { cookieOptions, loginToken, tokenFingerprint, tokenLoginEnabled, tokenUser } from '../loginConfig';
import { noteViewerTokenUse, viewerTokenForSession, type ViewerToken } from '../viewerTokens';

export const RETURN_COOKIE = 'return_to';
const RETURN_MAX_AGE_MS = 10 * 60 * 1000;

// Who is signed in, in which account, with which role. The role is looked
// up on every request (migration P4, M §9.5): never from the cookie.
// `mcp`: an MCP token's internal /api call (spec 2026-10-27-mcp-server-design
// §6), acting as its issuer (`email`) with the issuer's current role.
// `viewer-token`: a cams-admin viewer token's session (design 2026-11-05
// §9.4), always role viewer, `viewerToken` its id, name and expiry.
export interface ViewerTokenInfo { id: string; name: string; expiresAt: number }
export interface Principal { email: string; via: 'google' | 'token' | 'viewer-token' | 'mcp'; account: AccountRef; role: Role; mcpTokenId?: string; viewerToken?: ViewerTokenInfo }
export type AuthState = { kind: 'none' } | { kind: 'choose'; email: string; memberships: Membership[]; viewerToken?: ViewerTokenInfo } | { kind: 'ok'; principal: Principal };

// A viewer token's accounts, as memberships with role viewer (by name, like membershipsOf).
export const viewerTokenMemberships = (t: ViewerToken): Membership[] => t.accounts.map((account) => ({ account, role: 'viewer' as const }));

// The single definition of "signed in". Memberships (the allow-list in file
// mode) are re-checked on every request, so removing an address locks that
// account out immediately rather than when its 7-day cookie expires. A token
// session (POST /auth/token) bypasses them, and only that kind: it must name
// the current CAMS_TOKEN_USER and carry the current token's fingerprint, so
// turning the token login off or changing the token ends it at once; its
// account is the token account (R4-14), always admin.
export function authState(req: Request): AuthState {
  // An MCP tool's internal call: the token's principal or nothing, never the cookie.
  if (isInternal(req)) {
    const p = internalPrincipal(req);
    return p ? { kind: 'ok', principal: p } : { kind: 'none' };
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string') return { kind: 'none' };
  const session = verifySession(token);
  if (!session) return { kind: 'none' };
  const multi = configMode() === 'cams-admin';
  // A viewer token (cams-admin mode only): looked up in the current fleet on
  // every request, so a revoke, a shorter validity, the expiry or 24 h
  // without cams-admin ends the session (viewerTokenForSession).
  if (session.via === 'viewer-token') {
    const t = session.vt && session.tf ? viewerTokenForSession(session.vt, session.tf) : null;
    if (!t) return { kind: 'none' };
    if (noteViewerTokenUse(t.id)) reportSoon();
    const info = { id: t.id, name: t.name, expiresAt: t.expiresAt };
    const memberships = viewerTokenMemberships(t);
    const chosen = session.acc !== undefined ? memberships.find((m) => m.account.id === session.acc) : memberships.length === 1 ? memberships[0] : undefined;
    if (chosen) return { kind: 'ok', principal: { email: session.email, via: 'viewer-token', account: chosen.account, role: 'viewer', viewerToken: info } };
    if (session.acc !== undefined) return { kind: 'none' }; // the token no longer has that account
    return { kind: 'choose', email: session.email, memberships, viewerToken: info };
  }
  if (session.via === 'token') {
    const configured = loginToken();
    if (!configured || !tokenLoginEnabled()) return { kind: 'none' };
    if (session.email !== tokenUser() || session.tf !== tokenFingerprint(configured)) return { kind: 'none' };
    const t = tokenAccount();
    if (!t.ok || (multi && session.acc !== undefined && session.acc !== t.account.id)) return { kind: 'none' };
    return { kind: 'ok', principal: { email: session.email, via: 'token', account: t.account, role: 'admin' } };
  }
  const memberships = membershipsOf(session.email);
  if (!memberships.length) return { kind: 'none' };
  // File and shadow mode: one account; an acc in the cookie is ignored.
  const chosen = multi && session.acc !== undefined ? memberships.find((m) => m.account.id === session.acc) : memberships.length === 1 ? memberships[0] : undefined;
  if (chosen) return { kind: 'ok', principal: { email: session.email, via: 'google', account: chosen.account, role: chosen.role } };
  if (multi && session.acc !== undefined) return { kind: 'none' }; // no (longer a) member there
  return { kind: 'choose', email: session.email, memberships };
}

// Who this person is in one account right now (an MCP token's check, spec
// §6): a member's role there, or the token login's admin while that login is
// configured with the same user and token, as authState decides for sessions.
export function principalIn(id: { email: string; via: 'google' | 'token'; tf?: string }, accountId: string): Principal | null {
  if (id.via === 'token') {
    const configured = loginToken();
    if (!configured || !tokenLoginEnabled()) return null;
    if (id.email !== tokenUser() || id.tf !== tokenFingerprint(configured)) return null;
    const t = tokenAccount();
    if (!t.ok || t.account.id !== accountId) return null;
    return { email: id.email, via: 'token', account: t.account, role: 'admin' };
  }
  const m = membershipsOf(id.email).find((x) => x.account.id === accountId);
  return m ? { email: id.email, via: 'google', account: m.account, role: m.role } : null;
}

export function currentUser(req: Request): Principal | null {
  const s = authState(req);
  return s.kind === 'ok' ? s.principal : null;
}

// Only same-site /app paths: "/app", "/app/...", "/app?...". Anything that a
// browser could read as another origin ("//x", "/\x", absolute URLs) or that
// merely starts with the letters ("/apps") is refused. The web app has its
// own copy (web/src/lib/api.ts), so it never sends one the server drops.
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^\/app(?:[/?#]|$)/.test(value)) return null;
  if (value.includes('//') || value.includes('\\')) return null;
  // Browsers drop tabs and newlines from URLs, which could rebuild a "//".
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 2048) return null;
  // No "." or ".." segments, raw or percent-encoded: /app/../x would leave /app.
  const path = value.split(/[?#]/)[0];
  if (path.split('/').some((seg) => /^(\.|%2e){1,2}$/i.test(seg))) return null;
  return value;
}

// Where sign-in brings the visitor back to (the callback validates again
// before use). An unsafe path is ignored, never stored.
export function rememberReturn(res: Response, value: unknown): void {
  const path = safeReturnPath(value);
  if (!path) return;
  res.cookie(RETURN_COOKIE, path, { ...cookieOptions(), maxAge: RETURN_MAX_AGE_MS });
}

// A person who must choose an account gets the web app (it opens the picker).
export function requireAuthPage(req: Request, res: Response, next: NextFunction): void {
  if (authState(req).kind === 'none') {
    // Remember where the visitor was going, so sign-in can bring them back.
    rememberReturn(res, req.originalUrl);
    // A viewer token's session that ended (revoked, expired): its own sign-in page.
    res.redirect(302, expiredSessionKind(req.cookies?.[SESSION_COOKIE]) === 'viewer-token' ? '/token' : '/');
    return;
  }
  next();
}

// JSON, not a redirect: a fetch() following a redirect would get HTML back
// and fail far from the cause.
// A person who must choose an account (several, none chosen) gets 409
// choose_account, except on the picker's routes and GET /api/me.
const CHOOSE_OK = new Set(['GET /api/me', 'GET /api/accounts', 'POST /api/session/account']);
export function requireAuthApi(req: Request, res: Response, next: NextFunction): void {
  // The token API is for people signed in, never for a token's own calls.
  if (isInternal(req) && /^\/api\/mcp-tokens(\/|$)/i.test(`${req.baseUrl}${req.path}`)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const state = authState(req);
  res.locals.auth = state;
  if (state.kind === 'none') {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (state.kind === 'choose') {
    if (CHOOSE_OK.has(`${req.method} ${req.baseUrl}${req.path}`)) return next();
    res.status(409).json({ error: 'choose_account' });
    return;
  }
  res.locals.principal = state.principal;
  next();
}

// Camera pages and images must not sit in the browser cache after logout.
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}
