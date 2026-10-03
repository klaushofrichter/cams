import { expect, test, type Page } from '@playwright/test';
import { expireSession, fakeGoogle, rememberAccount, signIn } from './session';

// Issue #153, R2 (Klaus): when the session expires, renew it silently if
// Google can (prompt=none), back on the same page; else the sign-in page,
// whose sign-in also comes back to that page.

async function openSettings(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-settings').click();
  } else {
    await page.getByTestId('sidebar').getByTestId('nav-settings').click();
  }
}

test.describe('expired session', () => {
  test('is renewed silently and lands back on the same page', async ({ page, context, baseURL }, testInfo) => {
    await signIn(context, baseURL!);
    await rememberAccount(context, baseURL!);
    const calls = await fakeGoogle(context, baseURL!, () => 'sign-in');
    await page.goto('/app/about');
    await expect(page.getByTestId('page-title')).toHaveText('About');

    await expireSession(context, baseURL!);
    // The next request the page makes (Settings loads the camera's settings) gets the 401.
    await openSettings(page, testInfo.project.name === 'phone');

    await expect(page).toHaveURL(/\/app\/settings$/);
    await expect(page.getByTestId('page-title')).toHaveText('Settings');
    expect(calls).toEqual([{ prompt: 'none', loginHint: 'klaus@klaushofrichter.net' }]);
  });

  test('falls back to the sign-in page when Google needs the user, then returns to the same page', async ({ page, context, baseURL }, testInfo) => {
    await signIn(context, baseURL!);
    await rememberAccount(context, baseURL!);
    const calls = await fakeGoogle(context, baseURL!, (call) => (call.prompt === 'none' ? 'login_required' : 'sign-in'));
    await page.goto('/app/about');
    await expect(page.getByTestId('page-title')).toHaveText('About');

    await expireSession(context, baseURL!);
    await openSettings(page, testInfo.project.name === 'phone');

    // Silent renewal refused: the start page, no loop.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('login')).toBeVisible();
    expect(calls.map((c) => c.prompt)).toEqual(['none']);

    // The normal sign-in (account chooser) comes back to Settings.
    await page.getByTestId('login').click();
    await expect(page).toHaveURL(/\/app\/settings$/);
    await expect(page.getByTestId('page-title')).toHaveText('Settings');
    expect(calls.map((c) => c.prompt)).toEqual(['none', 'select_account']);
  });

  test('without a remembered account goes straight to the sign-in page', async ({ page, context, baseURL }, testInfo) => {
    await signIn(context, baseURL!);
    const calls = await fakeGoogle(context, baseURL!, () => 'sign-in');
    await page.goto('/app/about');
    await expect(page.getByTestId('page-title')).toHaveText('About');

    await expireSession(context, baseURL!);
    await openSettings(page, testInfo.project.name === 'phone');

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('login')).toBeVisible();
    expect(calls).toEqual([]);
    await page.getByTestId('login').click();
    await expect(page).toHaveURL(/\/app\/settings$/);
  });
});
