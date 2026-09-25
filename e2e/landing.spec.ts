import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.describe('landing page', () => {
  test('shows branding, the camera illustration and the Google login', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your cameras');
    await expect(page.getByText('Skylar Technology LLC').first()).toBeVisible();
    await expect(page.getByRole('img', { name: /RLC-1224A/ })).toBeVisible();
    const login = page.getByTestId('login');
    await expect(login).toHaveAttribute('href', '/auth/google/login');
  });

  test('login starts the Google flow', async ({ request }) => {
    const res = await request.get('/auth/google/login', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers().location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    // Always the account chooser, so a logged-out user is never signed back in silently.
    expect(new URL(res.headers().location).searchParams.get('prompt')).toBe('select_account');
  });

  test('has a favicon', async ({ request }) => {
    expect((await request.get('/favicon.svg')).status()).toBe(200);
  });
});

test.describe('auth boundaries', () => {
  test('signed-out app pages go back to the landing page', async ({ page }) => {
    await page.goto('/app/settings');
    await expect(page).toHaveURL('/');
  });

  test('signed-out API calls get 401 JSON', async ({ request }) => {
    const res = await request.get('/api/me');
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('signed-in visitors skip the landing page', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL!);
    await page.goto('/');
    await expect(page).toHaveURL('/app/live');
    await expect(page.getByTestId('page-title')).toHaveText('Live');
  });

  test('logout returns to the landing page and locks the app', async ({ page, context, baseURL }, testInfo) => {
    await signIn(context, baseURL!);
    await page.goto('/app/live');
    if (testInfo.project.name === 'phone') {
      await page.getByTestId('hamburger').click();
      await page.getByTestId('drawer').getByTestId('logout').click();
    } else {
      await page.getByTestId('logout').click();
    }
    await expect(page).toHaveURL('/');
    // Requirement: the authentication cookie is really gone.
    expect((await context.cookies()).map((c) => c.name)).not.toContain('session');
    await page.goto('/app/live');
    await expect(page).toHaveURL('/');
  });
});
