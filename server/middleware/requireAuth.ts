import { NextFunction, Request, Response } from 'express';
import { getAllowedEmails } from '../allowedEmails';
import { SESSION_COOKIE, SessionPayload, verifySession } from '../session';
import { cookieOptions, loginToken, tokenFingerprint, tokenLoginEnabled, tokenUser } from '../loginConfig';

export const RETURN_COOKIE = 'return_to';
const RETURN_MAX_AGE_MS = 10 * 60 * 1000;

// The single definition of "signed in". The allow-list is re-checked on every
// request, so removing an address locks that account out immediately rather
// than when its 7-day cookie expires. A token session (POST /auth/token)
// bypasses the allow-list, and only that kind: it must name the current
// CAMS_TOKEN_USER and carry the current token's fingerprint, so turning the
// token login off or changing the token ends it at once.
export function currentUser(req: Request): SessionPayload | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string') return null;
  const session = verifySession(token);
  if (!session) return null;
  if (session.via === 'token') {
    const configured = loginToken();
    if (!configured || !tokenLoginEnabled()) return null;
    return session.email === tokenUser() && session.tf === tokenFingerprint(configured) ? session : null;
  }
  return getAllowedEmails().includes(session.email) ? session : null;
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

export function requireAuthPage(req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(req)) {
    // Remember where the visitor was going, so sign-in can bring them back.
    rememberReturn(res, req.originalUrl);
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
