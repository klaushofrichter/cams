import type { BrowserContext } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { E2E_ENV } from './env';

// Signs a session exactly like server/session.ts, so signed-in specs need no
// Google round trip. The app has no test-only login route. `email` defaults to
// the first allowlisted user; specs that change preferences pass PREFS_EMAIL.
export async function signIn(context: BrowserContext, baseURL: string, email = E2E_ENV.ALLOWED_EMAILS.split(',')[0].trim()): Promise<void> {
  await context.addCookies([
    {
      name: 'session',
      value: jwt.sign({ email }, E2E_ENV.COOKIE_SECRET, { expiresIn: '10m' }),
      domain: new URL(baseURL).hostname,
      path: '/',
      httpOnly: true,
      secure: false, // http://localhost
      sameSite: 'Lax',
    },
  ]);
}
