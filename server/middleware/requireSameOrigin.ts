import { Request, Response, NextFunction } from 'express';

// CSRF defence for cookie-authenticated state-changing requests. SameSite=Lax
// already blocks the classic cross-site form POST; this is the server-side
// half, and it holds even if the cookie policy is ever loosened.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  // req.protocol honours X-Forwarded-Proto because `trust proxy` lists the
  // cluster CIDRs (server/trustProxy.ts); without that every POST would look
  // cross-origin (https page vs. http hop).
  const expected = `${req.protocol}://${req.get('host')}`;
  const actual = originOf(req.get('origin')) ?? originOf(req.get('referer'));
  // Browsers attach Origin to every cross-origin POST; a bare request is a
  // non-browser client with no ambient cookie to borrow.
  if (actual !== undefined && actual !== expected) {
    res.status(403).json({ error: 'cross-origin request rejected' });
    return;
  }
  next();
}
