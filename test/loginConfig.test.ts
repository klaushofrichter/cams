import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertRequiredEnv } from '../server/config';
import { cookieSecure, googleLoginEnabled, loginMethods, loginToken, tokenUser } from '../server/loginConfig';
import { logger } from '../server/logger';

// The variables these tests change, restored after each.
const NAMES = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'ALLOWED_EMAILS',
  'COOKIE_SECRET',
  'COOKIE_SECURE',
  'CAMS_LOGIN_TOKEN',
  'CAMS_LOGIN_TOKEN_FILE',
  'CAMS_TOKEN_USER',
] as const;
const saved: Record<string, string | undefined> = {};
const TOKEN = 'a-long-enough-demo-token-0123456789';
let dir: string;

beforeEach(() => {
  for (const n of NAMES) saved[n] = process.env[n];
  dir = mkdtempSync(join(tmpdir(), 'cams-token-'));
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function noGoogle(): void {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;
}

describe('startup: which sign-ins', () => {
  it('Google only (the cluster) starts, without a token', () => {
    expect(assertRequiredEnv()).toMatchObject({ google: true, token: false, cookieSecure: true });
    expect(loginMethods()).toEqual(['google']);
  });

  it('token only starts, without Google and without ALLOWED_EMAILS', () => {
    noGoogle();
    delete process.env.ALLOWED_EMAILS;
    process.env.CAMS_LOGIN_TOKEN = TOKEN;
    expect(assertRequiredEnv()).toMatchObject({ google: false, token: true });
    expect(loginMethods()).toEqual(['token']);
  });

  it('both: Google first', () => {
    process.env.CAMS_LOGIN_TOKEN = TOKEN;
    expect(assertRequiredEnv()).toMatchObject({ google: true, token: true });
    expect(loginMethods()).toEqual(['google', 'token']);
  });

  it('neither refuses to start', () => {
    noGoogle();
    expect(() => assertRequiredEnv()).toThrow(/no sign-in/i);
  });

  it('half a Google configuration refuses to start', () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    process.env.CAMS_LOGIN_TOKEN = TOKEN;
    expect(() => assertRequiredEnv()).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(googleLoginEnabled()).toBe(false);
  });

  it('Google still needs ALLOWED_EMAILS', () => {
    delete process.env.ALLOWED_EMAILS;
    expect(() => assertRequiredEnv()).toThrow(/ALLOWED_EMAILS/);
  });

  it('COOKIE_SECRET is always required', () => {
    noGoogle();
    process.env.CAMS_LOGIN_TOKEN = TOKEN;
    delete process.env.COOKIE_SECRET;
    expect(() => assertRequiredEnv()).toThrow(/COOKIE_SECRET/);
  });
});

describe('startup: the token', () => {
  it('refuses a token under 24 characters, without printing it', () => {
    process.env.CAMS_LOGIN_TOKEN = 'short-token-12345678901';
    expect('short-token-12345678901'.length).toBe(23);
    let message = '';
    try {
      assertRequiredEnv();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/CAMS_LOGIN_TOKEN.*24/);
    expect(message).not.toContain('short-token');
    expect(loginToken()).toBeNull();
  });

  it('counts the trimmed token', () => {
    process.env.CAMS_LOGIN_TOKEN = `   ${'x'.repeat(23)}  \n`;
    expect(() => assertRequiredEnv()).toThrow(/24/);
    process.env.CAMS_LOGIN_TOKEN = `  ${'x'.repeat(24)}\n`;
    expect(() => assertRequiredEnv()).not.toThrow();
    expect(loginToken()).toBe('x'.repeat(24));
  });

  it('reads CAMS_LOGIN_TOKEN_FILE (trailing newline trimmed)', () => {
    noGoogle();
    const file = join(dir, 'token');
    writeFileSync(file, `${TOKEN}\n`);
    process.env.CAMS_LOGIN_TOKEN_FILE = file;
    expect(assertRequiredEnv()).toMatchObject({ token: true });
    expect(loginToken()).toBe(TOKEN);
  });

  it('refuses an unreadable token file, naming the variable', () => {
    process.env.CAMS_LOGIN_TOKEN_FILE = join(dir, 'missing');
    expect(() => assertRequiredEnv()).toThrow(/CAMS_LOGIN_TOKEN_FILE/);
  });

  it('refuses a short token in a file', () => {
    const file = join(dir, 'token');
    writeFileSync(file, 'too-short\n');
    process.env.CAMS_LOGIN_TOKEN_FILE = file;
    expect(() => assertRequiredEnv()).toThrow(/24/);
  });

  it('refuses both token sources at once', () => {
    const file = join(dir, 'token');
    writeFileSync(file, TOKEN);
    process.env.CAMS_LOGIN_TOKEN = TOKEN;
    process.env.CAMS_LOGIN_TOKEN_FILE = file;
    expect(() => assertRequiredEnv()).toThrow(/CAMS_LOGIN_TOKEN and CAMS_LOGIN_TOKEN_FILE/);
  });

  it('CAMS_TOKEN_USER defaults to "local" and is validated', () => {
    process.env.CAMS_LOGIN_TOKEN = TOKEN;
    expect(tokenUser()).toBe('local');
    process.env.CAMS_TOKEN_USER = 'demo.kit';
    expect(tokenUser()).toBe('demo.kit');
    process.env.CAMS_TOKEN_USER = 'has space';
    expect(() => assertRequiredEnv()).toThrow(/CAMS_TOKEN_USER/);
  });
});

describe('startup: COOKIE_SECURE', () => {
  it('defaults to true', () => {
    delete process.env.COOKIE_SECURE;
    expect(cookieSecure()).toBe(true);
  });

  it('false turns Secure off, with a warning at startup', () => {
    const warn = vi.spyOn(logger, 'warn');
    process.env.COOKIE_SECURE = 'false';
    expect(assertRequiredEnv()).toMatchObject({ cookieSecure: false });
    expect(cookieSecure()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'cookie_secure_off');
  });

  it('true and 1/0 are accepted; anything else refuses to start', () => {
    process.env.COOKIE_SECURE = 'true';
    expect(assertRequiredEnv()).toMatchObject({ cookieSecure: true });
    process.env.COOKIE_SECURE = '0';
    expect(assertRequiredEnv()).toMatchObject({ cookieSecure: false });
    process.env.COOKIE_SECURE = 'no';
    expect(() => assertRequiredEnv()).toThrow(/COOKIE_SECURE/);
  });
});
