import { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OAUTH_STATE_COOKIE = 'oauth_state';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

// 'first' is the normal sign-in; 'reselect' is the single retry after the
// chosen account was not allowed. A disallowed account on the retry gets a
// 403, so it cannot loop.
export type LoginAttempt = 'first' | 'reselect';

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: 'openid email',
    state,
    // Always show Google's account chooser. Without it, a browser still
    // signed in to Google is let straight back in after Logout, which makes
    // Logout look like it did nothing. `attempt` only marks the retry.
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
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

export function redirectToGoogle(req: Request, res: Response, attempt: LoginAttempt): void {
  const nonce = issueNonce(req, res);
  res.redirect(302, buildGoogleAuthUrl(`${nonce}.${attempt}`));
}

export function checkState(req: Request): LoginAttempt | null {
  const cookie = req.cookies?.[OAUTH_STATE_COOKIE];
  const state = req.query.state;
  if (typeof cookie !== 'string' || typeof state !== 'string') return null;
  const dot = state.lastIndexOf('.');
  if (dot === -1) return null;
  const nonce = state.slice(0, dot);
  const attempt = state.slice(dot + 1);
  if (attempt !== 'first' && attempt !== 'reselect') return null;
  const presented = Buffer.from(nonce);
  const expected = Buffer.from(cookie);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return attempt;
}

export function clearState(res: Response): void {
  res.clearCookie(OAUTH_STATE_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax' });
}
