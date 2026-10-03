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

const FIRST_EMAIL = E2E_ENV.ALLOWED_EMAILS.split(',')[0].trim();

// The session cookie replaced by one that expired a minute ago, as the
// browser would hold it when the 7 days ran out mid-visit (issue #153, R2).
export async function expireSession(context: BrowserContext, baseURL: string, email = FIRST_EMAIL): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) - 60;
  await context.addCookies([
    { name: 'session', value: jwt.sign({ email, exp }, E2E_ENV.COOKIE_SECRET), domain: new URL(baseURL).hostname, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
}

// The login_hint cookie the callback sets on a real sign-in (silent renewal needs it).
export async function rememberAccount(context: BrowserContext, baseURL: string, email = FIRST_EMAIL): Promise<void> {
  await context.addCookies([
    { name: 'login_hint', value: encodeURIComponent(email), domain: new URL(baseURL).hostname, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
}

export interface FakeGoogleCall {
  prompt: string | null;
  loginHint: string | null;
}

// A stand-in for Google's authorization page. Playwright doesn't route the
// request a redirect leads to, so the stand-in sits on the real
// /auth/google/login: the server answers it as usual (cookies included) and
// its redirect to Google is answered here. The server's code exchange can't
// be faked from the browser (and the app has no test-only login route), so
// 'sign-in' plays the whole round trip: it signs the browser in like a
// successful callback and goes where the callback would (the remembered
// return_to page; the callback's own redirect is covered in
// test/auth.test.ts). 'login_required' answers like Google does when a
// prompt=none renewal needs the user: back to the real callback with the error.
export async function fakeGoogle(
  context: BrowserContext,
  baseURL: string,
  answer: (call: FakeGoogleCall) => 'sign-in' | 'login_required',
): Promise<FakeGoogleCall[]> {
  const calls: FakeGoogleCall[] = [];
  await context.route(/\/auth\/google\/login(\?|$)/, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    const location = res.headers().location ?? '';
    if (!location.startsWith('https://accounts.google.com/')) {
      await route.fulfill({ response: res });
      return;
    }
    const google = new URL(location);
    const call = { prompt: google.searchParams.get('prompt'), loginHint: google.searchParams.get('login_hint') };
    calls.push(call);
    if (answer(call) === 'login_required') {
      const back = `${baseURL}/auth/google/callback?error=login_required&state=${encodeURIComponent(google.searchParams.get('state') ?? '')}`;
      await route.fulfill({ response: res, headers: { ...res.headers(), location: back } });
      return;
    }
    await signIn(context, baseURL);
    const returnTo = (await context.cookies(baseURL)).find((c) => c.name === 'return_to')?.value;
    await context.clearCookies({ name: 'return_to' });
    await route.fulfill({ status: 302, headers: { location: `${baseURL}${returnTo ? decodeURIComponent(returnTo) : '/'}` } });
  });
  return calls;
}
