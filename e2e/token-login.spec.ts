import { expect, test } from '@playwright/test';
import { E2E_LOGIN_TOKEN } from './env';
import { openSignIn } from './landingSignIn';

// The Pi demo kit's sign-in (spec 2026-10-04-pi-deployment-design), against
// the second server (E2E_TOKEN_ENV: a login token, no Google, cookies
// without Secure). Projects token-desktop and token-phone.
test.describe('token login', () => {
  test('the start page has no token field; its Cams app button opens the sign-in page with the token form', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your cameras');
    await expect(page.getByTestId('token-input')).toHaveCount(0);
    await expect(page.getByText('Sign in with token')).toHaveCount(0);
    await expect(page.getByTestId('login')).toHaveCount(0);
    await openSignIn(page);
    await expect(page.getByTestId('admin-console')).toHaveAttribute('href', 'https://cams-admin.skylar.technology');
    const cams = page.getByTestId('cams-signin');
    await expect(cams).toHaveAttribute('href', '/signin');
    await cams.click();
    await expect(page).toHaveURL('/signin');
    await expect(page.getByTestId('token-form')).toBeVisible();
    await expect(page.getByTestId('token-input')).toHaveAttribute('type', 'password');
    await expect(page.getByTestId('token-submit')).toHaveText('Sign in with token');
    await expect(page.getByTestId('login')).toHaveCount(0);
    await expect(page.getByTestId('token-login-open')).toHaveCount(0);
  });

  test('a wrong token shows the error and signs nobody in', async ({ page, context }) => {
    await page.goto('/signin');
    await page.getByTestId('token-input').fill('not-the-token-at-all-0000000000');
    await page.getByTestId('token-submit').click();
    await expect(page.getByTestId('token-error')).toHaveText('That token is not right.');
    await expect(page).toHaveURL('/signin');
    expect((await context.cookies()).map((c) => c.name)).not.toContain('session');
  });

  test('the token signs in, back to the page asked for; logout locks the app again', async ({ page, context }, testInfo) => {
    // A signed-out visit to a page is remembered (#155) and returned to.
    await page.goto('/app/settings');
    await expect(page).toHaveURL('/');
    await openSignIn(page);
    await page.getByTestId('cams-signin').click();
    await expect(page).toHaveURL('/signin');
    await page.getByTestId('token-input').fill(E2E_LOGIN_TOKEN);
    await page.getByTestId('token-submit').click();
    await expect(page).toHaveURL('/app/settings');
    await expect(page.getByTestId('page-title')).toHaveText('Settings');
    const session = (await context.cookies()).find((c) => c.name === 'session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(false); // COOKIE_SECURE=false: works over http on the LAN
    const me = await page.request.get('/api/me');
    expect((await me.json()).email).toBe('local');

    if (testInfo.project.name === 'token-phone') {
      await page.getByTestId('hamburger').click();
      await page.getByTestId('drawer').getByTestId('drawer-logout').click();
    } else {
      await page.getByTestId('logout').click();
    }
    await expect(page).toHaveURL('/');
    expect((await context.cookies()).map((c) => c.name)).not.toContain('session');
    await page.goto('/app/video');
    await expect(page).toHaveURL('/');
    await openSignIn(page);
    await expect(page.getByTestId('cams-signin')).toBeVisible();
  });

  test('the notices show on the sign-in page, where the form posts come back', async ({ page }) => {
    await page.goto('/signin?login=failed');
    await expect(page.getByTestId('token-error')).toHaveText('That token is not right.');
    await page.goto('/signin?login=unavailable');
    await expect(page.getByTestId('login-unavailable')).toBeVisible();
    // A form post without JavaScript comes back to the sign-in page.
    const res = await page.request.post('/auth/token', { form: { token: 'not-the-token-at-all-0000000000' }, maxRedirects: 0, headers: { Origin: new URL(page.url()).origin } });
    expect(res.status()).toBe(303);
    expect(res.headers().location).toBe('/signin?login=failed');
  });

  test('Google sign-in is not offered: its routes lead back to the start page', async ({ request }) => {
    const res = await request.get('/auth/google/login', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers().location).toBe('/');
  });

  test('the token is never accepted in the URL', async ({ request }) => {
    const res = await request.post(`/auth/token?token=${E2E_LOGIN_TOKEN}`, { data: { token: E2E_LOGIN_TOKEN } });
    expect(res.status()).toBe(400);
  });
});
