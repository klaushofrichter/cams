import type { BrowserContext } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { E2E_ENV } from './env';

// Signs a session exactly like server/session.ts, so signed-in specs need no
// Google round trip. The app has no test-only login route.
export async function signIn(context: BrowserContext, baseURL: string): Promise<void> {
  const email = E2E_ENV.ALLOWED_EMAILS.split(',')[0].trim();
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
