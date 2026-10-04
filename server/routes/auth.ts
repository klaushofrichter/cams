import express, { NextFunction, Router, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { expiredSessionKind, SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession, signTokenSession } from '../session';
import { getAllowedEmails } from '../allowedEmails';
import { createAuthRateLimit, createTokenFailureLimit } from '../middleware/rateLimit';
import { RETURN_COOKIE, rememberReturn, safeReturnPath } from '../middleware/requireAuth';
import { requireSameOrigin } from '../middleware/requireSameOrigin';
import { checkState, clearLoginHint, clearState, loginHint, redirectToGoogle, setLoginHint } from '../googleLogin';
import { cookieOptions, googleLoginEnabled, loginToken, tokenFingerprint, tokenLoginEnabled, tokenUser } from '../loginConfig';
import { logger } from '../logger';

export const authRouter = Router();
const authRateLimit = createAuthRateLimit();
const tokenFailureLimit = createTokenFailureLimit();

export { safeReturnPath };

// ?returnTo=/app/... : where the callback goes after sign-in (validated, an
// unsafe value is ignored). ?silent=1 : the web app's renewal of an expired
// session (web/src/lib/api.ts), Google's prompt=none for the account of the
// last sign-in. Without that account's hint (never signed in here, or
// logged out) there is nothing to renew: the start page, as before.
authRouter.get('/auth/google/login', authRateLimit, (req: Request, res: Response) => {
  rememberReturn(res, req.query.returnTo);
  // No Google here (the Pi), or the session that ran out came from the token
  // login: nothing to renew with Google, the start page signs in again.
  if (!googleLoginEnabled()) {
    res.redirect(302, '/');
    return;
  }
  if (req.query.silent === '1') {
    if (expiredSessionKind(req.cookies?.[SESSION_COOKIE]) === 'token') {
      res.redirect(302, '/');
      return;
    }
    const hint = loginHint(req);
    if (hint) redirectToGoogle(req, res, 'silent', hint);
    else res.redirect(302, '/');
    return;
  }
  redirectToGoogle(req, res, 'first');
});

authRouter.get('/auth/google/callback', authRateLimit, async (req: Request, res: Response) => {
  if (!googleLoginEnabled()) {
    res.redirect(302, '/');
    return;
  }
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
  res.cookie(SESSION_COOKIE, signSession(email), { ...cookieOptions(), maxAge: SESSION_MAX_AGE_MS });
  setLoginHint(res, email);
  const returnTo = safeReturnPath(req.cookies?.[RETURN_COOKIE]);
  res.clearCookie(RETURN_COOKIE, cookieOptions());
  res.redirect(302, returnTo ?? '/');
});

// --- Token login (spec 2026-10-04-pi-deployment-design) ---------------------
//
// The Pi demo kit's sign-in: one shared token (CAMS_LOGIN_TOKEN), posted from
// the start page. Never in a URL; the body is never logged (pino-http logs no
// bodies, and the lines below carry no token, agent or address). The digests
// make the comparison constant-time whatever length was sent.
const MAX_TOKEN_BYTES = 1024;
// Only if the token file vanished between the two checks; the same answer as the pages router's.
const next404 = (res: Response): void => {
  res.status(404).type('text/plain').send('Not found');
};
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

function tokenMatches(presented: unknown, expected: string): boolean {
  const candidate = typeof presented === 'string' && presented.length > 0 && presented.length <= MAX_TOKEN_BYTES ? presented : '';
  // Always compare, so a missing token takes the same path as a wrong one.
  const same = timingSafeEqual(digest(candidate), digest(expected));
  return same && candidate.length > 0;
}

// Token login off: the route doesn't exist (the normal unknown-path 404).
// The same-origin check comes before the failure limiter, so cross-site
// posts can't use up the owner's tries.
authRouter.use('/auth/token', (_req: Request, _res: Response, next: NextFunction) => (tokenLoginEnabled() ? next() : next('router')));
authRouter.post(
  '/auth/token',
  authRateLimit,
  requireSameOrigin,
  tokenFailureLimit,
  express.urlencoded({ extended: false, limit: '4kb' }),
  (req: Request, res: Response) => {
    const expected = loginToken();
    if (!expected) {
      next404(res);
      return;
    }
    const form = !req.is('application/json');
    if (req.query.token !== undefined) {
      logger.warn({ kind: 'auth' }, 'token_login_failed');
      res.status(400).json({ error: 'token_in_url' });
      return;
    }
    if (!tokenMatches((req.body as { token?: unknown } | undefined)?.token, expected)) {
      logger.warn({ kind: 'auth' }, 'token_login_failed');
      if (form) res.redirect(303, '/?login=failed');
      else res.status(401).json({ error: 'invalid_token' });
      return;
    }
    res.locals.tokenOk = true;
    res.cookie(SESSION_COOKIE, signTokenSession(tokenUser(), tokenFingerprint(expected)), { ...cookieOptions(), maxAge: SESSION_MAX_AGE_MS });
    // No Google renewal for this browser (it would be for another account).
    clearLoginHint(res);
    clearState(res);
    const returnTo = safeReturnPath(req.cookies?.[RETURN_COOKIE]);
    if (req.cookies?.[RETURN_COOKIE] !== undefined) res.clearCookie(RETURN_COOKIE, cookieOptions());
    logger.info({ kind: 'auth' }, 'token_login');
    if (form) res.redirect(303, returnTo ?? '/');
    else res.json({ redirect: returnTo ?? '/app/video' });
  },
);

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
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.clearCookie(RETURN_COOKIE, cookieOptions());
  clearState(res);
  clearLoginHint(res);
  res.redirect(302, '/');
});
