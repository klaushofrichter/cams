import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession } from '../session';
import { getAllowedEmails } from '../allowedEmails';
import { createAuthRateLimit } from '../middleware/rateLimit';
import { RETURN_COOKIE } from '../middleware/requireAuth';
import { checkState, clearState, redirectToGoogle } from '../googleLogin';

export const authRouter = Router();
const authRateLimit = createAuthRateLimit();
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'lax' as const };

// Only same-site /app paths: "/app", "/app/...", "/app?...". Anything that a
// browser could read as another origin ("//x", "/\x", absolute URLs) or that
// merely starts with the letters ("/apps") is refused.
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^\/app(?:[/?]|$)/.test(value)) return null;
  if (value.includes('//') || value.includes('\\')) return null;
  // No "." or ".." segments, raw or percent-encoded: /app/../x would leave /app.
  const path = value.split('?')[0];
  if (path.split('/').some((seg) => /^(\.|%2e){1,2}$/i.test(seg))) return null;
  return value;
}

authRouter.get('/auth/google/login', authRateLimit, (req: Request, res: Response) => {
  redirectToGoogle(req, res, 'first');
});

authRouter.get('/auth/google/callback', authRateLimit, async (req: Request, res: Response) => {
  // The user cancelled at Google (or Google refused): back to the start page,
  // never a JSON error page.
  if (req.query.error !== undefined) {
    clearState(res);
    res.redirect('/');
    return;
  }
  const code = req.query.code;
  if (typeof code !== 'string' || code.length === 0) {
    res.status(401).json({ error: 'missing authorization code' });
    return;
  }
  // Before the code is redeemed: a callback this browser did not start must
  // not be able to sign it in, whoever's code it carries.
  const attempt = checkState(req);
  if (!attempt) {
    res.status(401).json({ error: 'invalid state' });
    return;
  }

  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  let email: string | undefined;
  try {
    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token ?? '', audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    email = payload?.email_verified ? payload.email : undefined;
  } catch {
    res.status(401).json({ error: 'authentication failed' });
    return;
  }
  if (!email) {
    res.status(401).json({ error: 'authentication failed' });
    return;
  }

  if (!getAllowedEmails().includes(email)) {
    if (attempt === 'first') {
      redirectToGoogle(req, res, 'reselect');
      return;
    }
    clearState(res);
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  clearState(res);
  res.cookie(SESSION_COOKIE, signSession(email), { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE_MS });
  const returnTo = safeReturnPath(req.cookies?.[RETURN_COOKIE]);
  res.clearCookie(RETURN_COOKIE, COOKIE_OPTS);
  res.redirect(302, returnTo ?? '/');
});

// Logout clears exactly the three cookies this app sets (session, return_to,
// oauth_state), with the same attributes they were set with, so the next
// visit really needs a fresh Google sign-in (which always shows the account
// chooser, see googleLogin.ts). localStorage (theme, sidebar) is kept.
//
// Clear-Site-Data is deliberately not used here: it applies to the whole
// registrable domain, not just this origin, so it would also sign the user
// out of every other *.skylar.technology service sharing the browser.
authRouter.get('/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, COOKIE_OPTS);
  res.clearCookie(RETURN_COOKIE, COOKIE_OPTS);
  clearState(res);
  res.redirect(302, '/');
});
