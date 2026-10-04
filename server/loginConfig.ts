import { createHash } from 'crypto';
import { readFileSync } from 'fs';

// Which sign-ins this server offers, and how its cookies are flagged
// (spec 2026-10-04-pi-deployment-design). The cluster: Google only, Secure
// cookies. The Pi demo kit: a login token, cookies over http.
//
// The request-time readers below never throw: a value that is wrong turns the
// feature off (no token login, Secure cookies). assertRequiredEnv()
// (server/config.ts) checks the same values strictly at startup, through
// checkLoginEnv(), so a wrong value never gets as far as a request.

export const MIN_TOKEN_LENGTH = 24;
const TOKEN_USER_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;
const GOOGLE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;

export type LoginMethod = 'google' | 'token';

export function googleLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return GOOGLE_VARS.every((name) => !!env[name]);
}

type TokenRead = { token: string } | { error: string } | { none: true };

// Read once per distinct (value, file) pair: a changed file takes effect on
// restart, like every other Secret. Never part of an error message.
let cached: { key: string; read: TokenRead } | null = null;

function readToken(env: NodeJS.ProcessEnv): TokenRead {
  const value = env.CAMS_LOGIN_TOKEN;
  const file = env.CAMS_LOGIN_TOKEN_FILE;
  const key = `${value ?? ''}\u0000${file ?? ''}`;
  if (cached?.key === key) return cached.read;
  let read: TokenRead;
  if (value && file) {
    read = { error: 'Set only one of CAMS_LOGIN_TOKEN and CAMS_LOGIN_TOKEN_FILE' };
  } else if (!value && !file) {
    read = { none: true };
  } else {
    let raw: string | null = value ?? null;
    if (file) {
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        raw = null;
      }
    }
    const name = file ? 'CAMS_LOGIN_TOKEN_FILE' : 'CAMS_LOGIN_TOKEN';
    if (raw === null) read = { error: `${name}: the file can't be read` };
    else if (raw.trim().length < MIN_TOKEN_LENGTH) read = { error: `${name}: the login token must have at least ${MIN_TOKEN_LENGTH} characters` };
    else read = { token: raw.trim() };
  }
  cached = { key, read };
  return read;
}

// The configured login token, or null when token login is off (or invalid).
export function loginToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const read = readToken(env);
  return 'token' in read ? read.token : null;
}

export function tokenLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return loginToken(env) !== null && TOKEN_USER_PATTERN.test(tokenUser(env));
}

// The identity a token session has. Bypasses ALLOWED_EMAILS (and only for
// sessions made by the token login, see currentUser()).
export function tokenUser(env: NodeJS.ProcessEnv = process.env): string {
  return env.CAMS_TOKEN_USER || 'local';
}

// Ties a token session to the token it was made with: changing the token
// signs those sessions out. 64 bits of a hash, inside the signed (httpOnly)
// session cookie.
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(`cams-token-session\u0000${token}`).digest('hex').slice(0, 16);
}

export function loginMethods(env: NodeJS.ProcessEnv = process.env): LoginMethod[] {
  const methods: LoginMethod[] = [];
  if (googleLoginEnabled(env)) methods.push('google');
  if (tokenLoginEnabled(env)) methods.push('token');
  return methods;
}

function parseCookieSecure(value: string | undefined): boolean | null {
  if (value === undefined || value === '' || value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

// Secure cookies unless COOKIE_SECURE is explicitly false (the Pi over http).
export function cookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseCookieSecure(env.COOKIE_SECURE) ?? true;
}

// The attributes of every cookie cams sets; clearing must use the same ones.
export function cookieOptions(): { httpOnly: true; secure: boolean; sameSite: 'lax' } {
  return { httpOnly: true, secure: cookieSecure(), sameSite: 'lax' };
}

export interface LoginSummary {
  google: boolean;
  token: boolean;
  cookieSecure: boolean;
}

// Strict: the startup check. Errors name variables, never values.
export function checkLoginEnv(env: NodeJS.ProcessEnv = process.env): LoginSummary {
  const set = GOOGLE_VARS.filter((name) => !!env[name]);
  if (set.length > 0 && set.length < GOOGLE_VARS.length) {
    const missing = GOOGLE_VARS.filter((name) => !env[name]);
    throw new Error(`Google sign-in is half configured: set ${missing.join(', ')} too, or none of ${GOOGLE_VARS.join(', ')}`);
  }
  const google = set.length === GOOGLE_VARS.length;
  const read = readToken(env);
  if ('error' in read) throw new Error(read.error);
  const token = 'token' in read;
  if (token && !TOKEN_USER_PATTERN.test(tokenUser(env))) {
    throw new Error('CAMS_TOKEN_USER must be 1 to 64 letters, digits or . _ @ -');
  }
  if (!google && !token) {
    throw new Error('No sign-in configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI, or CAMS_LOGIN_TOKEN (or CAMS_LOGIN_TOKEN_FILE)');
  }
  const secure = parseCookieSecure(env.COOKIE_SECURE);
  if (secure === null) throw new Error('COOKIE_SECURE must be true or false');
  return { google, token, cookieSecure: secure };
}
