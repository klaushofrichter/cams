import jwt from 'jsonwebtoken';

export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  email: string;
}

function getCookieSecret(): string {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error('COOKIE_SECRET is not set');
  return secret;
}

export function signSession(email: string): string {
  return jwt.sign({ email }, getCookieSecret(), { algorithm: 'HS256', expiresIn: '7d' });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    // Pinned: a token signed with any other algorithm is not a session.
    const decoded = jwt.verify(token, getCookieSecret(), { algorithms: ['HS256'] });
    if (typeof decoded === 'object' && decoded !== null && typeof (decoded as { email?: unknown }).email === 'string') {
      return { email: (decoded as { email: string }).email };
    }
    return null;
  } catch {
    return null;
  }
}
