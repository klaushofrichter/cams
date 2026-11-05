import jwt from 'jsonwebtoken';
import { ACCOUNT_ID_RE } from './fleet';
import { SESSION_TAG_RE, VIEWER_TOKEN_ID_RE, viewerTokenUser } from './viewerTokens';

export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// `via: 'token'` marks a session made by the token login (POST /auth/token),
// with `tf`, the fingerprint of the token it was made with. A session
// without `via` is a Google one. `acc`: the account chosen (cams-admin
// mode, migration P4); never a role: roles are looked up on every request.
// `via: 'viewer-token'`: a cams-admin viewer token's session (POST
// /auth/viewer-token), with `vt` its id and `tf` 16 hex of its fingerprint;
// its `exp` is the token's expiry, and every request checks the token again.
export interface SessionPayload {
  email: string;
  via?: 'token' | 'viewer-token';
  tf?: string;
  vt?: string;
  acc?: string;
}

function getCookieSecret(): string {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error('COOKIE_SECRET is not set');
  return secret;
}

export function signSession(email: string, acc?: string): string {
  return jwt.sign({ email, ...(acc && { acc }) }, getCookieSecret(), { algorithm: 'HS256', expiresIn: '7d' });
}

export function signTokenSession(user: string, fingerprint: string, acc?: string): string {
  return jwt.sign({ email: user, via: 'token', tf: fingerprint, ...(acc && { acc }) }, getCookieSecret(), { algorithm: 'HS256', expiresIn: '7d' });
}

// A viewer token's session until the token's expiry (`expiresAt`, ms).
export function signViewerTokenSession(id: string, tag: string, expiresAt: number, acc?: string): string {
  return jwt.sign({ email: viewerTokenUser(id), via: 'viewer-token', vt: id, tf: tag, exp: Math.floor(expiresAt / 1000), ...(acc && { acc }) }, getCookieSecret(), { algorithm: 'HS256' });
}

function payloadOf(decoded: unknown): SessionPayload | null {
  if (typeof decoded !== 'object' || decoded === null) return null;
  const d = decoded as { email?: unknown; via?: unknown; tf?: unknown; vt?: unknown; acc?: unknown };
  if (typeof d.email !== 'string') return null;
  const acc = typeof d.acc === 'string' && ACCOUNT_ID_RE.test(d.acc) ? { acc: d.acc } : {};
  if (d.via === 'viewer-token') {
    if (typeof d.vt !== 'string' || !VIEWER_TOKEN_ID_RE.test(d.vt) || typeof d.tf !== 'string' || !SESSION_TAG_RE.test(d.tf) || d.email !== viewerTokenUser(d.vt)) return null;
    return { email: d.email, via: 'viewer-token', vt: d.vt, tf: d.tf, ...acc };
  }
  if (d.via === 'token') return { email: d.email, via: 'token', ...(typeof d.tf === 'string' && { tf: d.tf }), ...acc };
  return { email: d.email, ...acc };
}

export function verifySession(token: string): SessionPayload | null {
  try {
    // Pinned: a token signed with any other algorithm is not a session.
    return payloadOf(jwt.verify(token, getCookieSecret(), { algorithms: ['HS256'] }));
  } catch {
    return null;
  }
}

// What kind of session this was, even after it expired (the signature still
// has to hold). Only for choosing how to sign in again, never for access.
export function expiredSessionKind(token: unknown): 'token' | 'viewer-token' | 'google' | null {
  if (typeof token !== 'string') return null;
  try {
    const payload = payloadOf(jwt.verify(token, getCookieSecret(), { algorithms: ['HS256'], ignoreExpiration: true }));
    if (!payload) return null;
    return payload.via ?? 'google';
  } catch {
    return null;
  }
}
