import jwt from 'jsonwebtoken';

export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// `via: 'token'` marks a session made by the token login (POST /auth/token),
// with `tf`, the fingerprint of the token it was made with. A session
// without `via` is a Google one.
export interface SessionPayload {
  email: string;
  via?: 'token';
  tf?: string;
}

function getCookieSecret(): string {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error('COOKIE_SECRET is not set');
  return secret;
}

export function signSession(email: string): string {
  return jwt.sign({ email }, getCookieSecret(), { algorithm: 'HS256', expiresIn: '7d' });
}

export function signTokenSession(user: string, fingerprint: string): string {
  return jwt.sign({ email: user, via: 'token', tf: fingerprint }, getCookieSecret(), { algorithm: 'HS256', expiresIn: '7d' });
}

function payloadOf(decoded: unknown): SessionPayload | null {
  if (typeof decoded !== 'object' || decoded === null) return null;
  const d = decoded as { email?: unknown; via?: unknown; tf?: unknown };
  if (typeof d.email !== 'string') return null;
  if (d.via === 'token') return { email: d.email, via: 'token', ...(typeof d.tf === 'string' && { tf: d.tf }) };
  return { email: d.email };
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
export function expiredSessionKind(token: unknown): 'token' | 'google' | null {
  if (typeof token !== 'string') return null;
  try {
    const payload = payloadOf(jwt.verify(token, getCookieSecret(), { algorithms: ['HS256'], ignoreExpiration: true }));
    if (!payload) return null;
    return payload.via === 'token' ? 'token' : 'google';
  } catch {
    return null;
  }
}
