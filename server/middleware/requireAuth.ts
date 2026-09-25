import { NextFunction, Request, Response } from 'express';
import { getAllowedEmails } from '../allowedEmails';
import { SESSION_COOKIE, SessionPayload, verifySession } from '../session';

export const RETURN_COOKIE = 'return_to';
const RETURN_MAX_AGE_MS = 10 * 60 * 1000;

// The single definition of "signed in". The allow-list is re-checked on every
// request, so removing an address locks that account out immediately rather
// than when its 7-day cookie expires.
export function currentUser(req: Request): SessionPayload | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string') return null;
  const session = verifySession(token);
  if (!session) return null;
  return getAllowedEmails().includes(session.email) ? session : null;
}

export function requireAuthPage(req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(req)) {
    // Remember where the visitor was going, so sign-in can bring them back.
    // Only /app paths are stored; the callback validates again before use.
    if (req.originalUrl.startsWith('/app')) {
      res.cookie(RETURN_COOKIE, req.originalUrl, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: RETURN_MAX_AGE_MS,
      });
    }
    res.redirect(302, '/');
    return;
  }
  next();
}

// JSON, not a redirect: a fetch() following a redirect would get HTML back
// and fail far from the cause.
export function requireAuthApi(req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

// Camera pages and images must not sit in the browser cache after logout.
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}
