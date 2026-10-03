import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession } from '../session';
import { getAllowedEmails } from '../allowedEmails';
import { createAuthRateLimit } from '../middleware/rateLimit';
import { RETURN_COOKIE, rememberReturn, safeReturnPath } from '../middleware/requireAuth';
import { checkState, clearLoginHint, clearState, loginHint, redirectToGoogle, setLoginHint } from '../googleLogin';

export const authRouter = Router();
const authRateLimit = createAuthRateLimit();
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'lax' as const };

export { safeReturnPath };

// ?returnTo=/app/... : where the callback goes after sign-in (validated, an
// unsafe value is ignored). ?silent=1 : the web app's renewal of an expired
// session (web/src/lib/api.ts), Google's prompt=none for the account of the
// last sign-in. Without that account's hint (never signed in here, or
// logged out) there is nothing to renew: the start page, as before.
authRouter.get('/auth/google/login', authRateLimit, (req: Request, res: Response) => {
  rememberReturn(res, req.query.returnTo);
  if (req.query.silent === '1') {
    const hint = loginHint(req);
    if (hint) redirectToGoogle(req, res, 'silent', hint);
    else res.redirect(302, '/');
    return;
  }
  redirectToGoogle(req, res, 'first');
});

authRouter.get('/auth/google/callback', authRateLimit, async (req: Request, res: Response) => {
  // The user cancelled at Google (or Google refused, or a silent renewal
  // needs the user: login_required, interaction_required, ...): back to the
  // start page, never a JSON error page. return_to is kept, so the normal
  // sign-in from there still comes back to the same page.
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
    if (attempt === 'silent') {
      // The remembered account is no longer allowed: forget it, and let the
      // user sign in from the start page (no chooser was asked for).
      clearLoginHint(res);
      res.redirect(302, '/');
      return;
    }
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  clearState(res);
  res.cookie(SESSION_COOKIE, signSession(email), { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE_MS });
  setLoginHint(res, email);
  const returnTo = safeReturnPath(req.cookies?.[RETURN_COOKIE]);
  res.clearCookie(RETURN_COOKIE, COOKIE_OPTS);
  res.redirect(302, returnTo ?? '/');
});

// Logout clears exactly the four cookies this app sets (session, return_to,
// oauth_state, login_hint), with the same attributes they were set with, so the next
// visit really needs a fresh Google sign-in (which always shows the account
// chooser, see googleLogin.ts; without login_hint no silent renewal is
// tried). localStorage (theme, sidebar) is kept.
//
// Clear-Site-Data is deliberately not used here: it applies to the whole
// registrable domain, not just this origin, so it would also sign the user
// out of every other *.skylar.technology service sharing the browser.
// Rate-limited like sign-in, as it rewrites the same cookies (CodeQL
// js/missing-rate-limiting).
authRouter.get('/auth/logout', authRateLimit, (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, COOKIE_OPTS);
  res.clearCookie(RETURN_COOKIE, COOKIE_OPTS);
  clearState(res);
  clearLoginHint(res);
  res.redirect(302, '/');
});
