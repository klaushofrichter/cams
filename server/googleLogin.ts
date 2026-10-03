import { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OAUTH_STATE_COOKIE = 'oauth_state';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export const LOGIN_HINT_COOKIE = 'login_hint';
// Longer than the 7-day session on purpose: the hint is what lets an expired
// session be renewed silently. It grants nothing by itself (Google still has
// to sign the account in, and the callback re-checks the allow-list).
export const LOGIN_HINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const HINT_PATTERN = /^[^\s@,;"\\]{1,64}@[^\s@,;"\\]{1,190}$/;

// 'first' is the normal sign-in; 'reselect' is the single retry after the
// chosen account was not allowed. A disallowed account on the retry gets a
// 403, so it cannot loop. 'silent' renews an expired session without any
// Google page (prompt=none); when Google needs the user it answers the
// callback with ?error=login_required (or similar), which lands on the start page.
export type LoginAttempt = 'first' | 'reselect' | 'silent';

export function buildGoogleAuthUrl(state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: 'openid email',
    state,
    // Always show Google's account chooser for a sign-in the user started.
    // Without it, a browser still signed in to Google is let straight back
    // in after Logout, which makes Logout look like it did nothing. The
    // attempt marker travels inside `state` (see redirectToGoogle), not as a
    // parameter here. Only the silent renewal (which needs the login hint
    // that Logout deletes) asks Google for no page at all.
    prompt: loginHint === undefined ? 'select_account' : 'none',
    ...(loginHint === undefined ? {} : { login_hint: loginHint }),
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

// The account of the last sign-in, when the browser still has it.
export function loginHint(req: Request): string | null {
  const value = req.cookies?.[LOGIN_HINT_COOKIE];
  return typeof value === 'string' && HINT_PATTERN.test(value) ? value : null;
}

export function setLoginHint(res: Response, email: string): void {
  if (!HINT_PATTERN.test(email)) return;
  res.cookie(LOGIN_HINT_COOKIE, email, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: LOGIN_HINT_MAX_AGE_MS });
}

export function clearLoginHint(res: Response): void {
  res.clearCookie(LOGIN_HINT_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax' });
}

// Login-CSRF defence: the nonce lives in an httpOnly cookie and travels to
// Google in `state`; the callback accepts a code only when they match. An
// existing nonce is reused so a second tab does not clobber a login in flight.
function issueNonce(req: Request, res: Response): string {
  const existing = req.cookies?.[OAUTH_STATE_COOKIE];
  const nonce = typeof existing === 'string' && NONCE_PATTERN.test(existing) ? existing : randomBytes(16).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    // Lax: the callback arrives as a top-level redirect from Google.
    sameSite: 'lax',
    maxAge: STATE_MAX_AGE_MS,
  });
  return nonce;
}

export function redirectToGoogle(req: Request, res: Response, attempt: 'first' | 'reselect'): void;
export function redirectToGoogle(req: Request, res: Response, attempt: 'silent', hint: string): void;
export function redirectToGoogle(req: Request, res: Response, attempt: LoginAttempt, hint?: string): void {
  const nonce = issueNonce(req, res);
  res.redirect(302, buildGoogleAuthUrl(`${nonce}.${attempt}`, attempt === 'silent' ? hint : undefined));
}

export function checkState(req: Request): LoginAttempt | null {
  const cookie = req.cookies?.[OAUTH_STATE_COOKIE];
  const state = req.query.state;
  if (typeof cookie !== 'string' || typeof state !== 'string') return null;
  if (!NONCE_PATTERN.test(cookie)) return null;
  const dot = state.lastIndexOf('.');
  if (dot === -1) return null;
  const nonce = state.slice(0, dot);
  const attempt = state.slice(dot + 1);
  if (attempt !== 'first' && attempt !== 'reselect' && attempt !== 'silent') return null;
  const presented = Buffer.from(nonce);
  const expected = Buffer.from(cookie);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return attempt;
}

export function clearState(res: Response): void {
  res.clearCookie(OAUTH_STATE_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax' });
}
